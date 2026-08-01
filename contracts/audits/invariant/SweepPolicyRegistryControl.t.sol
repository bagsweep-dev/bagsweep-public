// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// BagSweep in-house audit — invariant #5: SweepPolicyRegistry owner-retains-control.
//
// Guarantees, across any mix of accounts authoring/revoking policies and a non-owner
// attempting to pause:
//
//   INV-1  no stored policy can exceed the caps (pct <= MAX_PCT, slippage <= MAX_SLIPPAGE,
//          whitelist <= MAX_WHITELIST) — the executor trusts these bounds, so a user must
//          never be able to author a policy past them
//   INV-2  only the owner can pause — a non-owner call can never flip `paused` (owner control)
//   INV-3  the active-account list is exactly the active set: totalAccounts == policyCount
//          (revoke prunes; the list can't grow without bound — the H7/M7 fix)
//
// Policies are self-authored (setPolicy/revokePolicy key off msg.sender), so the handler
// pranks as several distinct accounts to exercise the list and the caps.

import {Test} from "forge-std/Test.sol";
import {SweepPolicyRegistry} from "../../contracts/SweepPolicyRegistry.sol";
import {SweepPolicy, SweepMode, Destination} from "../../contracts/interfaces/ISweepPolicy.sol";

contract RegistryActor is Test {
    SweepPolicyRegistry public reg;
    address[] public accts;

    constructor(SweepPolicyRegistry _reg, address[] memory _accts) {
        reg = _reg; accts = _accts;
    }

    function setPolicy(uint256 who, uint256 pctSeed, uint256 slipSeed) external {
        address a = accts[who % accts.length];
        uint16 pct = uint16(bound(pctSeed, 0, 5000));       // spans past MAX_PCT (2500) -> should revert
        uint16 slip = uint16(bound(slipSeed, 0, 9000));     // spans past MAX_SLIPPAGE (5000) -> should revert
        address[] memory empty = new address[](0);
        vm.prank(a);
        try reg.setPolicy(pct, 0, SweepMode.POSITION, Destination.USDG_YIELD, empty, slip) {} catch {}
    }

    function revoke(uint256 who) external {
        address a = accts[who % accts.length];
        vm.prank(a);
        try reg.revokePolicy() {} catch {}
    }

    /// A non-owner (this handler) trying to pause — must always revert.
    function tryPause(bool p) external {
        try reg.setPaused(p) {} catch {}
    }
}

contract SweepPolicyRegistryControlTest is Test {
    SweepPolicyRegistry reg;
    RegistryActor actor;
    address[] accts;

    function setUp() public {
        reg = new SweepPolicyRegistry(address(this)); // owner = test
        accts.push(address(0x1001));
        accts.push(address(0x1002));
        accts.push(address(0x1003));
        accts.push(address(0x1004));
        actor = new RegistryActor(reg, accts);
        targetContract(address(actor));
    }

    /// INV-1: no stored policy exceeds the caps.
    function invariant_capsHold() public view {
        for (uint256 i = 0; i < accts.length; i++) {
            SweepPolicy memory p = reg.getPolicy(accts[i]);
            assertLe(p.pct, reg.MAX_PCT(), "pct exceeded the cap");
            assertLe(p.maxSlippageBps, reg.MAX_SLIPPAGE_BPS(), "slippage exceeded the cap");
            assertLe(p.tokenWhitelist.length, reg.MAX_WHITELIST(), "whitelist exceeded the cap");
        }
    }

    /// INV-2: a non-owner can never pause. The owner (test) never pauses, so this stays false.
    function invariant_onlyOwnerCanPause() public view {
        assertEq(reg.paused(), false, "a non-owner flipped the pause");
    }

    /// INV-3: the tracked list equals the active set (revoke prunes; no unbounded growth).
    function invariant_listIsExactlyActive() public view {
        assertEq(reg.totalAccounts(), reg.policyCount(), "tracked list drifted from the active set");
    }
}
