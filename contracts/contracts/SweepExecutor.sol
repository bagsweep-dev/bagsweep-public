// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {
    ISweepExecutor,
    SwapParams
} from "./interfaces/ISweepExecutor.sol";
import {
    Destination,
    SweepPolicy
} from "./interfaces/ISweepPolicy.sol";
import {SweepPolicyRegistry} from "./SweepPolicyRegistry.sol";

/// @title SweepExecutor
/// @author BagSweep
/// @notice Stateless sweep execution: pulls meme tokens from the caller
///         (SmartAccount), swaps them via a DEX router, and routes proceeds
///         to the configured destination. Called via the EntryPoint through
///         the user's SmartAccount.
contract SweepExecutor is ISweepExecutor, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @dev maximum meme tokens in a single sweep batch
    uint256 public constant MAX_SWAPS = 10;

    /// @dev Selector of swapExactTokensForTokens(uint256,uint256,address[],address,uint256).
    ///      The keeper-supplied meme->USDG swap must be this call, so the executor can
    ///      pin its recipient and output token (see {_requireSelfRoutedUsdgSwap}).
    bytes4 private constant SWAP_SELECTOR =
        bytes4(keccak256("swapExactTokensForTokens(uint256,uint256,address[],address,uint256)"));

    /// @dev Robinhood Chain USDG (Paxos Global Dollar, 6 decimals)
    address public immutable USDG;

    /// @dev the policy registry (to validate the caller has an active policy)
    SweepPolicyRegistry public immutable registry;

    /// @dev optional lending pool for USDG_YIELD deposits (set by owner)
    address public yieldPool;

    /// @dev optional second DEX router for USDG→stockToken swaps (STOCKS dest)
    address public stockRouter;

    /// @dev owner-sanctioned DEX routers permitted for meme→USDG swaps.
    ///      Constrains the keeper to real venues; blocks routing into a fake pool.
    mapping(address => bool) public sanctionedRouter;

    /// @dev owner-sanctioned stock tokens permitted as a STOCKS destination.
    ///      Blocks the keeper from swapping USDG into an attacker-controlled token.
    mapping(address => bool) public sanctionedStock;

    /// @dev Hard ceiling on the protocol fee (basis points). `feeBps` can be set
    ///      anywhere in [0, MAX_FEE_BPS] but never above it, so the fee is bounded
    ///      the same way the keeper is — it can never become a drain vector.
    uint256 public constant MAX_FEE_BPS = 100; // 1.00%

    /// @dev Protocol fee in basis points, skimmed from USDG proceeds. Default 0,
    ///      so accounts keep 100% until a fee is deliberately turned on.
    uint256 public feeBps;

    /// @dev Fee sink: the treasury / buyback-burn contract. When address(0) the
    ///      fee is skipped entirely, regardless of `feeBps`.
    address public treasury;

    /// @dev Per-account sweep cooldown (M-3): minimum seconds between successful sweeps of the
    ///      same account. Enforced on-chain so a compromised keeper cannot chain N successive
    ///      pct-of-balance sweeps into a same-block geometric liquidation. 0 = disabled; set
    ///      via the timelock post-deploy (e.g. 1h). The off-chain keeper cooldown is not a
    ///      security boundary against the keeper's own key; this is.
    uint256 public minSweepInterval;
    mapping(address => uint256) public lastSweepAt;

    // ─── Policy-enforcement errors (a compromised keeper cannot exceed these) ───
    error NoActivePolicy();
    error DestinationMismatch();
    error TokenNotAllowed();
    error RouterNotSanctioned();
    error AmountExceedsPolicy();
    error SlippageFloorRequired();
    error StockNotSanctioned();
    error FeeExceedsMax();
    error DuplicateToken();
    error UnsafeSwapData();
    error InvalidInterval();
    error SweepsPaused();
    error SweepCooldown();
    error ZeroAddress();

    /// @notice Emitted for every fee skim, so each fee is a verifiable chain read.
    event FeeCollected(address indexed account, uint256 usdgFee, uint256 feeBps, uint256 timestamp);
    /// @notice Emitted whenever the fee rate or treasury changes.
    event FeeConfigured(uint256 feeBps, address treasury);
    /// @notice Emitted when the per-account sweep cooldown changes.
    event MinSweepIntervalSet(uint256 interval);
    // Trust-anchor config events, so a guardian can monitor where money can route.
    event YieldPoolSet(address indexed pool);
    event StockRouterSet(address indexed router);
    event RouterSanctioned(address indexed router, bool ok);
    event StockSanctioned(address indexed token, bool ok);
    event TokensRescued(address indexed token, uint256 amount, address indexed to);

    constructor(
        address _usdg,
        address _registry,
        address initialOwner
    ) Ownable(initialOwner) {
        // USDG and registry are immutable: a zero here would permanently brick the
        // executor (every balanceOf/getPolicy call reverts) with no recovery path.
        if (_usdg == address(0) || _registry == address(0)) revert ZeroAddress();
        USDG = _usdg;
        registry = SweepPolicyRegistry(_registry);
        // Secure-by-default cooldown: an account is never exposed to same-block
        // geometric liquidation even if the deploy step forgets to configure it.
        // Governance can retune (down to 0) via setMinSweepInterval (timelocked).
        minSweepInterval = 1 hours;
    }

    // ─────────────────────────── Core Sweep ──────────────────────────

    /// @inheritdoc ISweepExecutor
    function executeSweep(
        SwapParams[] calldata swaps,
        Destination dest,
        address stockTarget,
        uint256 stockSpotQuote
    ) external override nonReentrant {
        if (swaps.length == 0 || swaps.length > MAX_SWAPS) revert SweepTooManyTokens();

        // Guardian emergency stop: the registry's pause is controlled by the fast
        // guardian (not the timelock), and it now halts the money-movement path,
        // not just new policy registration. Users can always still exit while
        // paused: revokePolicy and SmartAccount.ownerExecute are never gated.
        if (registry.paused()) revert SweepsPaused();

        address account = msg.sender;

        // Per-account rate limit (M-3): bounds a compromised keeper to one sweep per interval,
        // so it cannot chain successive pct-of-balance sweeps into a geometric liquidation.
        if (minSweepInterval != 0 && block.timestamp < lastSweepAt[account] + minSweepInterval) {
            revert SweepCooldown();
        }

        // ─── On-chain policy enforcement — the keeper is NOT trusted here ───
        // Whatever the keeper submits, it cannot exceed the user's own policy:
        // the account must have an active policy, the destination must match it,
        // and each swap is bounded below.
        SweepPolicy memory pol = registry.getPolicy(account);
        if (!pol.active) revert NoActivePolicy();
        if (dest != pol.dest) revert DestinationMismatch();
        if (dest == Destination.STOCKS || dest == Destination.SPLIT_50_50) {
            if (!sanctionedStock[stockTarget]) revert StockNotSanctioned();
        }

        uint256 totalUsdgReceived = 0;

        for (uint256 i = 0; i < swaps.length; i++) {
            SwapParams calldata s = swaps[i];

            // Reject a token that already appears earlier in this batch. `maxIn`
            // below is recomputed on the CURRENT balance each iteration, so
            // repeating a token would let the cumulative sweep compound past the
            // user's pct cap (e.g. ten 25% swaps of one token liquidate ~94%).
            // One swap per token makes the per-swap cap equal the per-call cap.
            for (uint256 j = 0; j < i; j++) {
                if (swaps[j].tokenIn == s.tokenIn) revert DuplicateToken();
            }

            // token must be permitted by the policy whitelist (empty list = any token)
            if (pol.tokenWhitelist.length > 0 && !_inWhitelist(pol.tokenWhitelist, s.tokenIn)) {
                revert TokenNotAllowed();
            }
            // the DEX router must be owner-sanctioned (a real venue, not a fake pool)
            if (!sanctionedRouter[s.router]) revert RouterNotSanctioned();
            // The swap must be a swapExactTokensForTokens that sells this token for
            // USDG and delivers the output to THIS contract. Pinning the recipient
            // is what stops a compromised keeper from redirecting proceeds: the
            // balance-delta floor below is NOT sufficient on its own, because the
            // keeper picks the declared spotQuote and can round the floor to 0.
            _requireSelfRoutedUsdgSwap(s.swapData, s.tokenIn, s.amountIn);
            // cap the sell at pct% of the account's CURRENT balance. This bounds
            // both POSITION and PROFITS modes (profit <= position value), so a
            // compromised keeper can never sweep more than the policy allows.
            uint256 maxIn = IERC20(s.tokenIn).balanceOf(account) * pol.pct / 10000;
            if (s.amountIn == 0 || s.amountIn > maxIn) revert AmountExceedsPolicy();
            // The keeper declares a spot quote; the ENFORCED output floor is the
            // user's own policy tolerance applied to it:
            //   floor = spotQuote * (10000 - maxSlippageBps) / 10000.
            // Reject a zero quote AND a quote small enough that integer division
            // rounds the floor to 0, so the keeper can never execute with no
            // effective floor. This moves the slippage tolerance from keeper choice
            // to user policy; it does NOT stop a keeper that manipulates spot (RH
            // has no oracle), which stays bounded by the pct cap above.
            if (s.spotQuote == 0) revert SlippageFloorRequired();
            uint256 floor = s.spotQuote * (10000 - pol.maxSlippageBps) / 10000;
            if (floor == 0) revert SlippageFloorRequired();

            // 1. Pull meme tokens from the SmartAccount
            uint256 balBefore = IERC20(s.tokenIn).balanceOf(address(this));
            IERC20(s.tokenIn).safeTransferFrom(account, address(this), s.amountIn);
            uint256 received = IERC20(s.tokenIn).balanceOf(address(this)) - balBefore;
            if (received != s.amountIn) revert SweepAmountMismatch();

            // 2. Approve DEX router and execute swap (meme → USDG)
            IERC20(s.tokenIn).forceApprove(s.router, s.amountIn);

            uint256 usdgBefore = IERC20(USDG).balanceOf(address(this));
            (bool ok, bytes memory ret) = s.router.call(s.swapData);
            if (!ok) {
                string memory reason = ret.length > 0
                    ? _extractRevertReason(ret)
                    : "swap failed";
                emit SweepFailed(account, s.tokenIn, s.amountIn, reason, block.timestamp);
                // Reset the dangling approval and refund the unsold tokens.
                IERC20(s.tokenIn).forceApprove(s.router, 0);
                IERC20(s.tokenIn).safeTransfer(account, s.amountIn);
                continue;
            }
            // Clear any residual approval after a successful swap.
            IERC20(s.tokenIn).forceApprove(s.router, 0);

            // Defense in depth (belt-and-suspenders to the encoded-amountIn check in
            // _requireSelfRoutedUsdgSwap): refund any tokenIn the router did not
            // consume, so a swap can never strand the user's input on this executor.
            uint256 tokenInLeft = IERC20(s.tokenIn).balanceOf(address(this)) - balBefore;
            if (tokenInLeft > 0) IERC20(s.tokenIn).safeTransfer(account, tokenInLeft);

            uint256 usdgReceived = IERC20(USDG).balanceOf(address(this)) - usdgBefore;
            if (usdgReceived < floor) revert SweepSlippageExceeded();

            totalUsdgReceived += usdgReceived;

            emit SweepExecuted(
                account,
                s.tokenIn,
                s.amountIn,
                usdgReceived,
                dest,
                block.timestamp
            );
        }

        // 3. Skim the capped protocol fee from the proceeds, then route the rest.
        //    Proceeds (net of fee) always return to `account`.
        if (totalUsdgReceived == 0) return;
        lastSweepAt[account] = block.timestamp; // M-3: stamp only on a real sweep (a no-op does not consume the cooldown)

        uint256 fee = _skimFee(account, totalUsdgReceived);

        // For a stock destination, derive the USDG->stock output floor the same way
        // as the meme leg: the keeper declares an expected stock out (stockSpotQuote)
        // and the user's slippage tolerance sets the floor. Without this the stock
        // leg would swap at minOut=0 and be freely sandwiched.
        uint256 stockFloor = 0;
        if (dest == Destination.STOCKS || dest == Destination.SPLIT_50_50) {
            if (stockSpotQuote == 0) revert SlippageFloorRequired();
            stockFloor = stockSpotQuote * (10000 - pol.maxSlippageBps) / 10000;
            if (stockFloor == 0) revert SlippageFloorRequired();
        }

        _routeProceeds(account, totalUsdgReceived - fee, dest, stockTarget, stockFloor);
    }

    /// @dev Require the keeper-supplied swap to be a swapExactTokensForTokens that
    ///      sells `tokenIn` for USDG and delivers the output to THIS contract, so
    ///      the executor only ever credits the account with USDG that actually
    ///      lands here and the swap recipient cannot be redirected.
    function _requireSelfRoutedUsdgSwap(bytes calldata swapData, address tokenIn, uint256 expectedAmountIn) internal view {
        if (swapData.length < 4 || bytes4(swapData[0:4]) != SWAP_SELECTOR) revert UnsafeSwapData();
        (uint256 encodedAmountIn, , address[] memory path, address to, ) =
            abi.decode(swapData[4:], (uint256, uint256, address[], address, uint256));
        // The encoded input MUST equal the policy-capped amount that gets pulled from the
        // account: otherwise the keeper could pull `expectedAmountIn` but swap a smaller
        // amount, stranding the difference on this executor (keeper-controlled fund lock).
        if (encodedAmountIn != expectedAmountIn) revert UnsafeSwapData();
        if (to != address(this)) revert UnsafeSwapData();
        if (path.length < 2 || path[0] != tokenIn || path[path.length - 1] != USDG) revert UnsafeSwapData();
    }

    /// @dev Skim the protocol fee in USDG out of the proceeds and send it to the
    ///      treasury. Bounded by MAX_FEE_BPS and skipped when the rate is 0 or no
    ///      treasury is set, so the account keeps 100% by default and a compromised
    ///      owner can never turn the fee into a drain.
    function _skimFee(address account, uint256 usdgAmount) internal returns (uint256 fee) {
        uint256 bps = feeBps;
        if (bps == 0 || treasury == address(0)) return 0;
        fee = usdgAmount * bps / 10000;
        if (fee == 0) return 0;
        IERC20(USDG).safeTransfer(treasury, fee);
        emit FeeCollected(account, fee, bps, block.timestamp);
    }

    /// @dev Linear scan of the policy whitelist (small, user-authored lists).
    function _inWhitelist(address[] memory list, address token) internal pure returns (bool) {
        for (uint256 i = 0; i < list.length; i++) {
            if (list[i] == token) return true;
        }
        return false;
    }

    // ─────────────────────────── Routing ─────────────────────────────

    function _routeProceeds(
        address account,
        uint256 usdgAmount,
        Destination dest,
        address stockTarget,
        uint256 stockFloor
    ) internal {
        if (dest == Destination.USDG_YIELD) {
            _depositOrTransfer(account, usdgAmount);
        } else if (dest == Destination.STOCKS) {
            uint256 stockReceived = _swapToStock(usdgAmount, stockTarget, stockFloor);
            IERC20(stockTarget).safeTransfer(account, stockReceived);
        } else {
            // SPLIT_50_50
            uint256 half = usdgAmount / 2;
            _depositOrTransfer(account, half);

            uint256 stockReceived = _swapToStock(usdgAmount - half, stockTarget, stockFloor);
            IERC20(stockTarget).safeTransfer(account, stockReceived);
        }
    }

    /// @dev Deposit USDG into the yield pool, or transfer directly if the pool is
    ///      unset. Only treats the deposit as done if the pool ACTUALLY pulled the
    ///      USDG: a pool that returns success without pulling would otherwise strand
    ///      the proceeds on this stateless executor. On any shortfall, reset the
    ///      dangling approval and fall back to a direct transfer, so the account
    ///      always receives its proceeds.
    function _depositOrTransfer(address to, uint256 amount) internal {
        if (yieldPool != address(0)) {
            IERC20(USDG).forceApprove(yieldPool, amount);
            uint256 balBefore = IERC20(USDG).balanceOf(address(this));
            (bool ok, ) = yieldPool.call(
                abi.encodeWithSignature("deposit(uint256,address)", amount, to)
            );
            uint256 balAfter = IERC20(USDG).balanceOf(address(this));
            IERC20(USDG).forceApprove(yieldPool, 0); // always clear the approval
            // A pool that pulled any USDG (including a fee/rounding partial pull) counts
            // as a deposit; refund the unconsumed remainder to the account. This stops a
            // fee-taking pool from DoS-ing every USDG_YIELD sweep, and the account is
            // never short-changed. `consumed <= amount` since the approval caps the pull.
            uint256 consumed = balBefore > balAfter ? balBefore - balAfter : 0;
            if (ok && consumed > 0) {
                uint256 remainder = amount - consumed;
                if (remainder > 0) IERC20(USDG).safeTransfer(to, remainder);
                return;
            }
        }
        IERC20(USDG).safeTransfer(to, amount);
    }

    /// @dev Swap USDG → stock token via the stock DEX router, enforcing `stockFloor`
    ///      as the minimum stock output (the user-policy tolerance applied to the
    ///      keeper's declared stock quote). The floor is passed to the router AND
    ///      re-checked against the measured balance delta.
    function _swapToStock(uint256 usdgAmount, address stockTarget, uint256 stockFloor) internal returns (uint256) {
        require(stockRouter != address(0), "stock router not set");

        IERC20(USDG).forceApprove(stockRouter, usdgAmount);

        // Build a Uniswap-style swapExactTokensForTokens call
        // Path: USDG → stockTarget (direct pair)
        // If no direct pair, the keeper should encode a multi-hop path in advance.
        address[] memory path = new address[](2);
        path[0] = USDG;
        path[1] = stockTarget;

        uint256 balBefore = IERC20(stockTarget).balanceOf(address(this));

        (bool ok, ) = stockRouter.call(
            abi.encodeWithSignature(
                "swapExactTokensForTokens(uint256,uint256,address[],address,uint256)",
                usdgAmount,
                stockFloor, // enforce the user-authored floor at the router
                path,
                address(this),
                block.timestamp + 300
            )
        );
        require(ok, "stock swap failed");

        uint256 received = IERC20(stockTarget).balanceOf(address(this)) - balBefore;
        if (received < stockFloor) revert SweepSlippageExceeded();
        return received;
    }

    // ─────────────────────────── Admin ───────────────────────────────

    function setYieldPool(address _pool) external onlyOwner {
        yieldPool = _pool;
        emit YieldPoolSet(_pool);
    }

    function setStockRouter(address _router) external onlyOwner {
        stockRouter = _router;
        emit StockRouterSet(_router);
    }

    /// @notice Sanction (or unsanction) a DEX router for meme→USDG swaps.
    function setSanctionedRouter(address router, bool ok) external onlyOwner {
        if (router == address(0)) revert ZeroAddress();
        sanctionedRouter[router] = ok;
        emit RouterSanctioned(router, ok);
    }

    /// @notice Sanction (or unsanction) a stock token as a STOCKS destination.
    function setSanctionedStock(address token, bool ok) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        sanctionedStock[token] = ok;
        emit StockSanctioned(token, ok);
    }

    /// @notice Set the protocol fee in basis points. Reverts above MAX_FEE_BPS,
    ///         so the fee ceiling is fixed for the life of the contract.
    /// @dev    Governance-sensitive: route this through the timelock before mainnet.
    function setFeeBps(uint256 _feeBps) external onlyOwner {
        if (_feeBps > MAX_FEE_BPS) revert FeeExceedsMax();
        feeBps = _feeBps;
        emit FeeConfigured(_feeBps, treasury);
    }

    /// @notice Set the fee sink (treasury / buyback-burn contract). Zero disables
    ///         the fee entirely.
    /// @dev    Governance-sensitive: route this through the timelock before mainnet.
    function setTreasury(address _treasury) external onlyOwner {
        treasury = _treasury;
        emit FeeConfigured(feeBps, _treasury);
    }

    /// @notice Set the per-account sweep cooldown in seconds (0 disables). (M-3)
    /// @dev    Governance-sensitive: route through the timelock before mainnet.
    function setMinSweepInterval(uint256 _interval) external onlyOwner {
        if (_interval > 30 days) revert InvalidInterval();
        minSweepInterval = _interval;
        emit MinSweepIntervalSet(_interval);
    }

    /// @notice Rescue tokens that end up on this stateless executor (a stray transfer,
    ///         or a residual from a misbehaving venue). Governance-sensitive, like the
    ///         other owner setters: on mainnet the owner is the BagSweepTimelock, so a
    ///         rescue is delayed and visible on-chain, not a hot-key grab. In normal
    ///         operation nothing is held here to rescue: sweeps are atomic and refund
    ///         any unconsumed input, so the executor holds no user funds between calls.
    function rescueTokens(address token, uint256 amount, address to) external onlyOwner {
        IERC20(token).safeTransfer(to, amount);
        emit TokensRescued(token, amount, to);
    }

    // ─────────────────────────── Internal ────────────────────────────

    function _extractRevertReason(bytes memory ret) internal pure returns (string memory) {
        if (ret.length < 68) return "unknown";
        // Skip the 4-byte selector (Panic/Error)
        assembly {
            ret := add(ret, 4)
        }
        return abi.decode(ret, (string));
    }
}
