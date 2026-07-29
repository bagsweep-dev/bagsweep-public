// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title SweepBuyback
/// @author BagSweep
/// @notice Sink for BagSweep protocol fees (the USDG that SweepExecutor skims into
///         its `treasury`). Accumulated USDG can ONLY leave by being swapped for
///         $SWEEP and burned: there is no owner withdrawal path for USDG, so the
///         buyback-and-burn is enforced by the contract, not merely promised.
///         Deploy after $SWEEP exists, then point `SweepExecutor.treasury` here.
/// @dev    Non-proxy / immutable. Owner powers are bounded to sanctioning routers,
///         setting the keeper, and setting $SWEEP ONCE. The owner can never extract
///         the USDG fees and can never repoint the burn target to a decoy token.
contract SweepBuyback is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @dev standard burn sink; $SWEEP sent here is out of circulation forever.
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    /// @dev Robinhood Chain USDG (the fee asset). Only ever exits via buyback-burn.
    address public immutable USDG;

    /// @dev the $SWEEP token. Set once, then immutable.
    address public sweepToken;

    /// @dev address permitted to trigger buybacks. Bounds swap timing/MEV; it
    ///      cannot steal (output is burned) and cannot withdraw USDG (no path).
    address public keeper;

    /// @dev owner-sanctioned routers for the USDG→$SWEEP swap (real venues only,
    ///      so a buyback can never be routed into a fake pool).
    mapping(address => bool) public sanctionedRouter;

    /// @dev Rate-limit config. `minSweepOut` is keeper-chosen and RH has no oracle,
    ///      so a compromised keeper could self-sandwich a buyback to burn far below
    ///      fair value (it can waste the fee pool, though never withdraw the USDG).
    ///      These bound the damage: at most `maxSpendBps` of the balance per call,
    ///      no more often than every `cooldown`, so the bleed is slow and governance
    ///      has time to rotate the keeper. Tunable via the timelocked owner.
    uint256 public maxSpendBps = 2000; // 20% of the current balance per call
    uint256 public cooldown = 1 hours;
    uint256 public lastBuyback;

    error ZeroAddress();
    error NotKeeper();
    error SweepTokenNotSet();
    error SweepTokenAlreadySet();
    error RouterNotSanctioned();
    error SlippageFloorRequired();
    error BuybackSlippage();
    error CannotRescueProtocolAsset();
    error SpendExceedsCap();
    error Cooldown();
    error InvalidBps();

    /// @notice Emitted on every burn, so total buyback volume is a verifiable read.
    event BuybackBurned(uint256 usdgSpent, uint256 sweepBurned, address indexed caller, uint256 timestamp);
    event SweepTokenSet(address sweepToken);
    event KeeperSet(address keeper);
    event RouterSanctioned(address router, bool ok);
    event MaxSpendBpsSet(uint256 bps);
    event CooldownSet(uint256 secs);

    constructor(address _usdg, address initialOwner, address _keeper) Ownable(initialOwner) {
        if (_usdg == address(0) || _keeper == address(0)) revert ZeroAddress();
        USDG = _usdg;
        keeper = _keeper;
    }

    // ─────────────────────────── Buyback ──────────────────────────

    /// @notice Swap USDG held here into $SWEEP via a sanctioned router and burn it.
    /// @param  usdgAmount  USDG to approve for the swap (bounded by the balance).
    /// @param  minSweepOut mandatory slippage floor; a short or redirected swap reverts.
    /// @param  router      a sanctioned DEX router.
    /// @param  swapData    the encoded USDG→$SWEEP swap (output must land on this contract).
    /// @dev    Keeper-gated to bound swap timing/MEV. The keeper cannot steal: the
    ///         $SWEEP output is measured by balance delta and burned in the same
    ///         call, and there is no path to withdraw the USDG.
    function buybackAndBurn(
        uint256 usdgAmount,
        uint256 minSweepOut,
        address router,
        bytes calldata swapData
    ) external nonReentrant returns (uint256 sweepBurned) {
        if (msg.sender != keeper) revert NotKeeper();
        address sweep = sweepToken;
        if (sweep == address(0)) revert SweepTokenNotSet();
        if (!sanctionedRouter[router]) revert RouterNotSanctioned();
        if (minSweepOut == 0) revert SlippageFloorRequired();

        uint256 usdgBefore = IERC20(USDG).balanceOf(address(this));
        // Rate-limit a compromised keeper: bounded spend per call + a cooldown.
        if (block.timestamp < lastBuyback + cooldown) revert Cooldown();
        if (usdgAmount > usdgBefore * maxSpendBps / 10000) revert SpendExceedsCap();
        lastBuyback = block.timestamp;

        uint256 sweepBefore = IERC20(sweep).balanceOf(address(this));

        IERC20(USDG).forceApprove(router, usdgAmount);
        (bool ok, bytes memory ret) = router.call(swapData);
        if (!ok) _bubble(ret); // reverts; the approval and all state are unwound
        IERC20(USDG).forceApprove(router, 0);

        sweepBurned = IERC20(sweep).balanceOf(address(this)) - sweepBefore;
        if (sweepBurned < minSweepOut) revert BuybackSlippage();

        uint256 usdgSpent = usdgBefore - IERC20(USDG).balanceOf(address(this));

        IERC20(sweep).safeTransfer(DEAD, sweepBurned);
        emit BuybackBurned(usdgSpent, sweepBurned, msg.sender, block.timestamp);
    }

    /// @notice Permissionlessly burn any $SWEEP sitting on this contract (dust from
    ///         a partial swap, or a stray transfer). Anyone may call; the only
    ///         possible destination is DEAD.
    function burnStuckSweep() external returns (uint256 burned) {
        address sweep = sweepToken;
        if (sweep == address(0)) revert SweepTokenNotSet();
        burned = IERC20(sweep).balanceOf(address(this));
        if (burned > 0) {
            IERC20(sweep).safeTransfer(DEAD, burned);
            emit BuybackBurned(0, burned, msg.sender, block.timestamp);
        }
    }

    // ─────────────────────────── Admin (bounded) ──────────────────

    /// @notice Set the $SWEEP token. Callable ONCE; immutable thereafter, so the
    ///         burn target can never be repointed to a decoy token.
    function setSweepToken(address _sweep) external onlyOwner {
        if (_sweep == address(0)) revert ZeroAddress();
        if (sweepToken != address(0)) revert SweepTokenAlreadySet();
        sweepToken = _sweep;
        emit SweepTokenSet(_sweep);
    }

    /// @notice Set the keeper that may trigger buybacks.
    /// @dev    Governance-sensitive: route through the timelock before mainnet.
    function setKeeper(address _keeper) external onlyOwner {
        if (_keeper == address(0)) revert ZeroAddress();
        keeper = _keeper;
        emit KeeperSet(_keeper);
    }

    /// @notice Sanction (or unsanction) a router for the USDG→$SWEEP swap.
    /// @dev    Governance-sensitive: route through the timelock before mainnet.
    function setSanctionedRouter(address router, bool ok) external onlyOwner {
        sanctionedRouter[router] = ok;
        emit RouterSanctioned(router, ok);
    }

    /// @notice Set the max USDG spent per buyback (bps of the current balance).
    /// @dev    Governance-sensitive: route through the timelock before mainnet.
    function setMaxSpendBps(uint256 bps) external onlyOwner {
        if (bps == 0 || bps > 10000) revert InvalidBps();
        maxSpendBps = bps;
        emit MaxSpendBpsSet(bps);
    }

    /// @notice Set the cooldown between buybacks (seconds).
    /// @dev    Governance-sensitive: route through the timelock before mainnet.
    function setCooldown(uint256 secs) external onlyOwner {
        cooldown = secs;
        emit CooldownSet(secs);
    }

    /// @notice Rescue a foreign token sent here by mistake. USDG (the fee asset,
    ///         which may only exit as a burn) and $SWEEP (which must be burned, via
    ///         burnStuckSweep) can NEVER be rescued — that is what makes the
    ///         buyback-and-burn credible rather than a promise.
    function rescue(address token, uint256 amount, address to) external onlyOwner {
        if (token == USDG || token == sweepToken) revert CannotRescueProtocolAsset();
        if (to == address(0)) revert ZeroAddress();
        IERC20(token).safeTransfer(to, amount);
    }

    // ─────────────────────────── Internal ──────────────────────────

    /// @dev Bubble the router's revert reason up to the caller.
    function _bubble(bytes memory ret) internal pure {
        if (ret.length > 0) {
            assembly {
                revert(add(ret, 0x20), mload(ret))
            }
        }
        revert("buyback swap failed");
    }
}
