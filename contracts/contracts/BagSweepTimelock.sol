// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

/// @title BagSweepTimelock
/// @author BagSweep
/// @notice Governance timelock that owns the BagSweep protocol config setters
///         (SweepExecutor and SweepBuyback, plus any other Ownable config surface).
///         Once ownership of those contracts is transferred here, every privileged
///         setter can only be QUEUED by a proposer and executed after `minDelay`.
///         A compromised proposer key therefore cannot change protocol config
///         silently or instantly: the pending change is public on-chain for the
///         whole delay, during which users can withdraw and exit. This is the
///         primary hardening for a single-EOA admin (timelock first, multisig
///         second), and it is solo-deployable with no off-chain infrastructure.
/// @dev    Thin wrapper over OpenZeppelin's audited TimelockController so it is
///         compiled into this project's artifacts and carries project NatSpec.
///         Roles (PROPOSER / EXECUTOR / CANCELLER / DEFAULT_ADMIN) and `minDelay`
///         are configured by the constructor exactly as in TimelockController.
///
///         NOTE ON EMERGENCY FUNCTIONS: a full delay is correct for config
///         (fees, routers, treasury, keeper), but NOT for an emergency pause,
///         which must be fast. Keep any pause on a separate fast guardian rather
///         than behind this timelock (see SECURITY.md).
contract BagSweepTimelock is TimelockController {
    /// @dev Sanity floor on `minDelay`. TimelockController accepts 0 (every op
    ///      instantly executable), which silently defeats the timelock's whole
    ///      purpose; require a meaningful minimum so a fat-fingered or stale deploy
    ///      can't ship a "timelock" that is not one.
    uint256 public constant MIN_DELAY_FLOOR = 1 hours;

    error DelayTooShort();

    /// @param minDelay   seconds a queued operation must wait before execution.
    /// @param proposers  addresses granted PROPOSER_ROLE (and CANCELLER_ROLE).
    /// @param executors  addresses granted EXECUTOR_ROLE (use address(0) to allow
    ///                    anyone to execute an already-queued, matured operation).
    /// @param admin      optional DEFAULT_ADMIN_ROLE holder for initial setup;
    ///                    pass address(0), or renounce after setup, to make the
    ///                    timelock fully self-administered.
    constructor(
        uint256 minDelay,
        address[] memory proposers,
        address[] memory executors,
        address admin
    ) TimelockController(minDelay, proposers, executors, admin) {
        if (minDelay < MIN_DELAY_FLOOR) revert DelayTooShort();
    }
}
