// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {
    ISweepPolicy,
    SweepPolicy,
    SweepMode,
    Destination
} from "./interfaces/ISweepPolicy.sol";

/// @title SweepPolicyRegistry
/// @author BagSweep
/// @notice Stores and manages user-authored sweep policies on-chain.
///         One active policy per smart account. The keeper reads this to
///         enumerate accounts that need monitoring.
contract SweepPolicyRegistry is ISweepPolicy, Ownable {
    /// @dev policy data per smart account
    mapping(address => SweepPolicy) private _policies;

    /// @dev ordered list of accounts that have ever set a policy
    address[] private _allAccounts;

    /// @dev fast lookup: is this account in _allAccounts?
    mapping(address => bool) private _isTracked;

    /// @dev 1-based index of an account in _allAccounts (0 = absent), for O(1)
    ///      swap-and-pop pruning on revoke.
    mapping(address => uint256) private _accountIndex;

    /// @dev emergency pause switch
    bool public paused;

    /// @notice Emitted when the guardian toggles the emergency pause.
    event PauseSet(bool paused);

    /// @dev max percentage allowed (25% = 2500 basis points)
    uint16 public constant MAX_PCT = 2500;

    /// @dev max slippage tolerance a user may authorize (50% = 5000 bps). Capped
    ///      below 100% so the derived output floor is always > 0 (a redirected or
    ///      zero-output swap still reverts).
    uint16 public constant MAX_SLIPPAGE_BPS = 5000;

    /// @dev max entries in a user's token whitelist. Bounds the O(list) scan the
    ///      executor runs per swap, so an oversized whitelist can't grief sweeps
    ///      (or the sponsor paying for them). User-authored lists are small.
    uint16 public constant MAX_WHITELIST = 50;

    constructor(address initialOwner) Ownable(initialOwner) {}

    // ─────────────────────────── Modifiers ───────────────────────────

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    // ─────────────────────────── Write ───────────────────────────────

    /// @inheritdoc ISweepPolicy
    function setPolicy(
        uint16 pct,
        uint128 minUsd,
        SweepMode mode,
        Destination dest,
        address[] calldata tokenWhitelist,
        uint16 maxSlippageBps
    ) external override whenNotPaused {
        if (pct == 0 || pct > MAX_PCT) revert InvalidPercentage();
        if (maxSlippageBps > MAX_SLIPPAGE_BPS) revert InvalidSlippage();
        if (tokenWhitelist.length > MAX_WHITELIST) revert WhitelistTooLong();

        address account = msg.sender;

        // Track the account if first time
        if (!_isTracked[account]) {
            _allAccounts.push(account);
            _isTracked[account] = true;
            _accountIndex[account] = _allAccounts.length; // 1-based
        }

        SweepPolicy storage p = _policies[account];
        p.pct = pct;
        p.maxSlippageBps = maxSlippageBps;
        p.minUsd = minUsd;
        p.mode = mode;
        p.dest = dest;
        p.active = true;

        // Overwrite whitelist
        delete p.tokenWhitelist;
        for (uint256 i = 0; i < tokenWhitelist.length; i++) {
            p.tokenWhitelist.push(tokenWhitelist[i]);
        }

        if (p.createdAt == 0) {
            p.createdAt = block.timestamp;
        }
        p.updatedAt = block.timestamp;

        emit PolicySet(account, pct, mode, dest, block.timestamp);
    }

    /// @inheritdoc ISweepPolicy
    function revokePolicy() external override {
        address account = msg.sender;
        SweepPolicy storage p = _policies[account];
        if (!p.active) revert PolicyNotFound(account);

        p.active = false;
        p.updatedAt = block.timestamp;

        // Prune from the active-account list (swap-and-pop) so enumeration tracks
        // the active set and cannot grow without bound as accounts churn.
        uint256 idx = _accountIndex[account]; // 1-based
        if (idx != 0) {
            address lastAccount = _allAccounts[_allAccounts.length - 1];
            _allAccounts[idx - 1] = lastAccount;
            _accountIndex[lastAccount] = idx;
            _allAccounts.pop();
            _accountIndex[account] = 0;
            _isTracked[account] = false;
        }

        emit PolicyRevoked(account, block.timestamp);
    }

    // ─────────────────────────── Read ────────────────────────────────

    /// @inheritdoc ISweepPolicy
    function getPolicy(address account) external view override returns (SweepPolicy memory) {
        return _policies[account];
    }

    /// @inheritdoc ISweepPolicy
    function policyCount() external view override returns (uint256 count) {
        for (uint256 i = 0; i < _allAccounts.length; i++) {
            if (_policies[_allAccounts[i]].active) {
                count++;
            }
        }
    }

    /// @inheritdoc ISweepPolicy
    function getActiveAccounts() external view override returns (address[] memory) {
        uint256 active;
        for (uint256 i = 0; i < _allAccounts.length; i++) {
            if (_policies[_allAccounts[i]].active) active++;
        }

        address[] memory result = new address[](active);
        uint256 j;
        for (uint256 i = 0; i < _allAccounts.length; i++) {
            if (_policies[_allAccounts[i]].active) {
                result[j++] = _allAccounts[i];
            }
        }
        return result;
    }

    /// @notice Number of accounts with a currently-active policy. Revoked accounts
    ///         are pruned from the list, so this equals policyCount().
    function totalAccounts() external view returns (uint256) {
        return _allAccounts.length;
    }

    // ─────────────────────────── Admin ───────────────────────────────

    /// @notice Toggle the emergency pause switch.
    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
        emit PauseSet(_paused);
    }
}
