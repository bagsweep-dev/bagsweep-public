// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// ─────────────────────── Uniswap V4 external interfaces ───────────────────────
/// Minimal local declarations so this file has no dependency on the v4 monorepo.
/// Verify each struct/selector against the CANONICAL RH Chain deployments before
/// sanctioning (same class of pre-deploy gate as the V3 adapter's
/// SwapRouter-vs-SwapRouter02 check).

type Currency is address;

/// @dev Uniswap V4 pool identifier. `fee` and `tickSpacing` select the pool the
///      same way the V3 fee tier did; `hooks` is the pool's hook contract —
///      launchpad pools (pmav/ORO graduated pools) have a NON-ZERO hook address.
struct PoolKey {
    Currency currency0;   // lower-sorted token
    Currency currency1;   // higher-sorted token
    uint24 fee;           // pool fee (or dynamic-fee sentinel if hook-managed)
    int24 tickSpacing;    // pool tick spacing
    address hooks;        // hook contract (launchpad hook for graduated pools)
}

/// @dev The V4Router "exact input single-pool" params (Universal-Router/V4Router
///      periphery encoding, Actions.SWAP_EXACT_IN_SINGLE).
struct ExactInputSingleParams {
    PoolKey poolKey;
    bool zeroForOne;          // true: currency0 -> currency1
    uint128 amountIn;
    uint128 amountOutMinimum;
    bytes hookData;           // forwarded to the pool's hook ("" unless required)
}

/// @dev The V4 periphery swap router (Uniswap's V4Router / UniversalRouter with
///      V4_SWAP). `execute` consumes encoded (actions, params) plan bytes.
interface IV4UniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

/// @dev Permit2, which the V4 periphery uses for ERC-20 pulls instead of raw
///      allowances. approve() grants the router a time-boxed allowance.
interface IPermit2 {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

/// @title SweepRouterV4Adapter
/// @author BagSweep
/// @notice Presents the Uniswap-V2 `swapExactTokensForTokens` interface that the
///         (frozen) SweepBuyback and SweepExecutor self-routed-swap checks require,
///         and internally routes through Uniswap V4 via the UniversalRouter's
///         V4_SWAP command. This lets the V2-shaped protocol contracts buy $REAP
///         from its launchpad-graduated V4 pool (USDG-curve pmav pool: a direct
///         USDG -> REAP hop) WITHOUT modifying any audited code: sanction this
///         adapter on SweepBuyback (and optionally SweepExecutor), and the keeper
///         builds V2-shaped paths to it exactly as it does for the V3 adapter.
///
/// @dev    SECURITY MODEL (mirrors SweepRouterV3Adapter):
///         - Non-custodial: pulls `path[0]` from the caller only, swaps, output
///           lands on `to`; holds no funds between calls.
///         - The caller's `amountOutMin` (the user/policy-authored floor upstream)
///           is forwarded UNMODIFIED into the V4 swap; a short fill reverts inside
///           the router, unwinding everything atomically.
///         - V2 `path[]` carries no V4 pool identity, so the owner configures the
///           FULL PoolKey per unordered token pair via {setPoolKey}; a hop with no
///           configured key reverts (`PoolKeyNotSet`) — no silent wrong-pool or
///           wrong-hook routing, the exact analogue of the V3 adapter's FeeNotSet.
///         - Misbehavior cannot steal: upstream, SweepBuyback/SweepExecutor
///           measure output by their own balance delta and revert below the floor.
///         - nonReentrant + approval reset + rescue event + zero-address guards,
///           same as the V3 adapter.
///
///         V4 OUTPUT DELIVERY: the V4 `TAKE_ALL` action has NO recipient field — it
///         always takes the output to the UniversalRouter's caller, which is THIS
///         adapter. So every hop's output lands on the adapter; the adapter measures
///         it by its own balance delta and, after the final hop, forwards the output
///         token to `to` with a plain ERC-20 transfer. (Do NOT try to pin the V4
///         recipient inside the plan; TAKE_ALL cannot address `to`.)
///
///         V4-SPECIFIC NOTES:
///         - `hooks` is part of pool identity. Launchpad-graduated pools carry the
///           launchpad's hook (e.g. the PmavHook), which may take its fee inside
///           the swap. The floor still protects the protocol: the hook can only
///           worsen output, never redirect it, and a short fill reverts.
///         - `hookData` is stored per pool (usually empty) in case a hook demands
///           a payload; stored — not caller-supplied — so a compromised keeper
///           cannot smuggle hook instructions through swap calldata.
///         - The V4 periphery pulls input via Permit2, so the adapter approves
///           Permit2 once per swap and grants the router a per-swap, amount- and
///           time-boxed Permit2 allowance, revoked after.
///
///         ⚠ PRE-DEPLOY GATE (do NOT skip; see contracts/scripts/forktest-v4.js):
///         pin the canonical RH Chain addresses of UniversalRouter + Permit2, read
///         the real PoolKey from the graduation Initialize event, and fork-test one
///         graduated-pool swap FROM A CONTRACT CALLER. Command/action byte values
///         (V4_SWAP / SWAP_EXACT_IN_SINGLE / SETTLE_ALL / TAKE_ALL) MUST be verified
///         against the deployed router version — a wrong byte is a total-DoS (every
///         swap reverts), not a fund loss. This adapter is POST-FREEZE and must not
///         be sanctioned on SweepBuyback until the fork test passes.
contract SweepRouterV4Adapter is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─────────── UniversalRouter / V4Router plan constants ───────────
    // Verify against the deployed RH UniversalRouter before sanctioning.
    uint8 internal constant CMD_V4_SWAP = 0x10;            // UniversalRouter Commands.V4_SWAP
    uint8 internal constant ACTION_SWAP_EXACT_IN_SINGLE = 0x06; // v4 Actions.SWAP_EXACT_IN_SINGLE
    uint8 internal constant ACTION_SETTLE_ALL = 0x0c;      // v4 Actions.SETTLE_ALL
    uint8 internal constant ACTION_TAKE_ALL = 0x0f;        // v4 Actions.TAKE_ALL

    /// @dev canonical Permit2 (same address on every EVM chain Uniswap deploys to).
    IPermit2 public immutable permit2;
    /// @dev RH Chain UniversalRouter (V4-capable).
    IV4UniversalRouter public immutable universalRouter;

    /// @dev Full V4 pool identity per unordered token pair:
    ///      keccak(sorted(a,b)) => PoolKey. The analogue of the V3 adapter's
    ///      poolFee mapping, extended to V4's richer pool identity.
    mapping(bytes32 => PoolKey) internal _poolKey;
    /// @dev true once a key is set for the pair (PoolKey has no reliable sentinel:
    ///      fee 0 and hook 0x0 are both legal V4 values).
    mapping(bytes32 => bool) public poolKeySet;
    /// @dev optional hook payload per pair (almost always empty).
    mapping(bytes32 => bytes) internal _hookData;

    error PathTooShort();
    error PoolKeyNotSet(address a, address b);
    error DeadlinePassed();
    error ZeroAddress();
    error PairMismatch();
    error AmountOverflow();

    event PoolKeySet(address indexed tokenA, address indexed tokenB, uint24 fee, int24 tickSpacing, address hooks);
    event HookDataSet(address indexed tokenA, address indexed tokenB, bytes hookData);
    event TokensRescued(address indexed token, uint256 amount, address indexed dest);

    constructor(address _universalRouter, address _permit2, address initialOwner) Ownable(initialOwner) {
        if (_universalRouter == address(0) || _permit2 == address(0)) revert ZeroAddress();
        universalRouter = IV4UniversalRouter(_universalRouter);
        permit2 = IPermit2(_permit2);
    }

    // ─────────────────────────── Swap (V2-shaped) ───────────────────────────

    /// @notice V2-compatible entrypoint SweepBuyback / SweepExecutor call. Routes
    ///         path[0] -> ... -> path[last] hop-by-hop through the configured V4
    ///         pools and sends the final output to `to`. `amountOutMin` is the
    ///         caller's slippage floor, enforced on the FINAL hop's output.
    /// @dev    Every V4 hop's output is TAKE_ALL'd to this adapter (V4 has no
    ///         recipient in the take action), so intermediate amounts naturally
    ///         stay here for the next hop and the terminal output is forwarded to
    ///         `to` after the loop. Only the terminal hop enforces `amountOutMin`;
    ///         the end-to-end floor is what the upstream contracts check anyway.
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external nonReentrant returns (uint256[] memory amounts) {
        if (path.length < 2) revert PathTooShort();
        if (block.timestamp > deadline) revert DeadlinePassed();
        if (to == address(0)) revert ZeroAddress();

        // Pull the input from the caller (which approved us), like the V3 adapter.
        IERC20(path[0]).safeTransferFrom(msg.sender, address(this), amountIn);

        amounts = new uint256[](path.length);
        amounts[0] = amountIn;

        uint256 hopIn = amountIn;
        for (uint256 i = 0; i < path.length - 1; i++) {
            uint256 floorOut = (i == path.length - 2) ? amountOutMin : 0;
            hopIn = _swapSingle(path[i], path[i + 1], hopIn, floorOut, deadline);
            amounts[i + 1] = hopIn;
        }

        // V4 TAKE_ALL delivered the final output to THIS adapter (it is the router's
        // caller). Forward it to `to`; upstream then measures its own balance delta.
        IERC20(path[path.length - 1]).safeTransfer(to, hopIn);
    }

    /// @dev Execute one exact-in single-pool V4 swap through the UniversalRouter. The
    ///      output is taken to this adapter (TAKE_ALL -> msgSender) and returned by
    ///      the adapter's own balance delta.
    function _swapSingle(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut,
        uint256 deadline
    ) internal returns (uint256 amountOut) {
        bytes32 key = _key(tokenIn, tokenOut);
        if (!poolKeySet[key]) revert PoolKeyNotSet(tokenIn, tokenOut);
        if (amountIn > type(uint128).max || minOut > type(uint128).max) revert AmountOverflow();

        PoolKey memory pk = _poolKey[key];
        bool zeroForOne = (tokenIn == Currency.unwrap(pk.currency0));
        // Defense-in-depth: the stored key must actually contain this pair.
        if (!zeroForOne && tokenIn != Currency.unwrap(pk.currency1)) revert PairMismatch();

        // Grant the router a per-swap, amount+time-boxed Permit2 allowance.
        IERC20(tokenIn).forceApprove(address(permit2), amountIn);
        permit2.approve(tokenIn, address(universalRouter), uint160(amountIn), uint48(deadline));

        // Build the V4 plan: one V4_SWAP command wrapping
        // [SWAP_EXACT_IN_SINGLE, SETTLE_ALL(tokenIn), TAKE_ALL(tokenOut, minOut)].
        bytes memory actions = abi.encodePacked(ACTION_SWAP_EXACT_IN_SINGLE, ACTION_SETTLE_ALL, ACTION_TAKE_ALL);
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(
            ExactInputSingleParams({
                poolKey: pk,
                zeroForOne: zeroForOne,
                amountIn: uint128(amountIn),
                amountOutMinimum: uint128(minOut),
                hookData: _hookData[key]
            })
        );
        params[1] = abi.encode(Currency.wrap(tokenIn), uint256(amountIn)); // SETTLE_ALL
        params[2] = abi.encode(Currency.wrap(tokenOut), uint256(minOut));  // TAKE_ALL floor

        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(actions, params);

        // Measure output by OUR OWN balance delta — never trust router return data
        // (same rule the executor applies to us). TAKE_ALL takes to this adapter.
        uint256 beforeBal = IERC20(tokenOut).balanceOf(address(this));
        universalRouter.execute(abi.encodePacked(CMD_V4_SWAP), inputs, deadline);
        amountOut = IERC20(tokenOut).balanceOf(address(this)) - beforeBal;

        // Revoke the residual approval so no allowance dangles between calls.
        IERC20(tokenIn).forceApprove(address(permit2), 0);
    }

    // ─────────────────────────── Views for the keeper ───────────────────────────

    /// @notice The configured PoolKey for a pair (zeroed if unset — check
    ///         {poolKeySet}). The keeper reads this for route selection, the
    ///         V4 analogue of the V3 adapter's {feeFor}.
    function poolKeyFor(address a, address b)
        external
        view
        returns (bool isSet, PoolKey memory keyOut)
    {
        bytes32 key = _key(a, b);
        return (poolKeySet[key], _poolKey[key]);
    }

    // ─────────────────────────── Admin (bounded) ───────────────────────────

    /// @notice Configure the V4 pool (full PoolKey) used for a token pair, in
    ///         both directions. For $REAP: the launchpad-graduated pool's exact
    ///         key — currencies sorted, its fee, tick spacing, and the launchpad
    ///         hook address, all read from the graduation event / explorer.
    /// @dev    Governance-sensitive: route through the timelock before mainnet
    ///         (a wrong-but-real pool degrades pricing; the upstream floor still
    ///         bounds the damage, same trust profile as V3's setPoolFee).
    function setPoolKey(
        address tokenA,
        address tokenB,
        uint24 fee,
        int24 tickSpacing,
        address hooks
    ) external onlyOwner {
        if (tokenA == address(0) || tokenB == address(0)) revert ZeroAddress();
        (address c0, address c1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        bytes32 key = _key(tokenA, tokenB);
        _poolKey[key] = PoolKey({
            currency0: Currency.wrap(c0),
            currency1: Currency.wrap(c1),
            fee: fee,
            tickSpacing: tickSpacing,
            hooks: hooks
        });
        poolKeySet[key] = true;
        emit PoolKeySet(tokenA, tokenB, fee, tickSpacing, hooks);
    }

    /// @notice Set an optional hook payload for a pair (rarely needed; stored on
    ///         the adapter so swap callers can never inject hook instructions).
    function setHookData(address tokenA, address tokenB, bytes calldata data) external onlyOwner {
        _hookData[_key(tokenA, tokenB)] = data;
        emit HookDataSet(tokenA, tokenB, data);
    }

    /// @notice Rescue a stray token (the adapter holds no funds between calls).
    function rescue(address token, uint256 amount, address dest) external onlyOwner {
        if (dest == address(0)) revert ZeroAddress();
        IERC20(token).safeTransfer(dest, amount);
        emit TokensRescued(token, amount, dest);
    }

    // ─────────────────────────── Internal ───────────────────────────

    function _key(address a, address b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }
}
