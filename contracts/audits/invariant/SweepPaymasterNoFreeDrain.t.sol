// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// BagSweep in-house audit — invariant #4: SweepPaymaster no-free-drain.
//
// H3 was "the paymaster deposit is drainable for free." The fix made it a verifying
// paymaster: a UserOp is sponsored ONLY when it carries a valid sponsorSigner signature
// bound to that exact op (sender, nonce, callData, gas, chain, this paymaster, window).
// This suite proves the fix as adversarial properties over fuzzed ops and signatures:
//
//   P1  a UserOp signed by the real sponsor is approved (sigOk)
//   P2  a UserOp signed by anyone else is rejected (sigFailed) — no free sponsorship
//   P3  a sponsor signature cannot be replayed onto a different op (nonce change)
//   P4  maxCost above the per-op ceiling reverts (belt-and-suspenders bound)
//   P5  with the signer disabled (address(0)), every op is rejected
//
// validate() reads no external storage, so a pranked EntryPoint is enough — no live
// EntryPoint needed. validationData's low 160 bits are 0 on success, 1 on sig failure.

import {Test} from "forge-std/Test.sol";
import {SweepPaymaster} from "../../contracts/SweepPaymaster.sol";
import {PackedUserOperation} from "@openzeppelin/contracts/interfaces/draft-IERC4337.sol";

contract SweepPaymasterNoFreeDrainTest is Test {
    SweepPaymaster pm;
    address entryPoint = address(0xEE47);
    uint256 sponsorKey = 0xA11CE;
    address sponsor;

    function setUp() public {
        pm = new SweepPaymaster(entryPoint, address(this));
        sponsor = vm.addr(sponsorKey);
        pm.setSponsorSigner(sponsor);
    }

    // Build a UserOp with the paymasterAndData header assembled and `sig` appended.
    function _op(address sender, uint256 nonce, bytes memory sig) internal view returns (PackedUserOperation memory op) {
        bytes memory pnd = abi.encodePacked(
            address(pm),                 // [0:20]
            bytes16(uint128(50_000)),    // [20:36] pm verification gas
            bytes16(uint128(50_000)),    // [36:52] pm postOp gas
            bytes6(uint48(type(uint48).max)), // [52:58] validUntil
            bytes6(uint48(0)),           // [58:64] validAfter
            sig                          // [64:]
        );
        op = PackedUserOperation({
            sender: sender,
            nonce: nonce,
            initCode: "",
            callData: hex"deadbeef",
            accountGasLimits: bytes32(uint256(100_000) << 128 | 100_000),
            preVerificationGas: 21_000,
            gasFees: bytes32(uint256(1 gwei) << 128 | 1 gwei),
            paymasterAndData: pnd,
            signature: ""
        });
    }

    // Sign the sponsorship digest for `op` with `key`.
    function _sign(PackedUserOperation memory op, uint256 key) internal view returns (bytes memory) {
        bytes32 hash = pm.getHash(op, type(uint48).max, 0);
        bytes32 digest = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", hash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    // Call validate as the EntryPoint; return the low 160 bits (0 = ok, 1 = sig failed).
    function _validate(PackedUserOperation memory op, uint256 maxCost) internal returns (uint256) {
        vm.prank(entryPoint);
        (, uint256 vd) = pm.validatePaymasterUserOp(op, bytes32(0), maxCost);
        return uint160(vd);
    }

    /// P1: the real sponsor's signature is accepted.
    function test_sponsorApproved() public {
        PackedUserOperation memory op = _op(address(0x1111), 1, new bytes(65));
        op = _op(address(0x1111), 1, _sign(op, sponsorKey));
        assertEq(_validate(op, 0.001 ether), 0, "a validly-sponsored op was rejected");
    }

    /// P2: no one else can get an op sponsored — the core no-free-drain property.
    function testFuzz_wrongSignerRejected(uint256 keySeed) public {
        uint256 key = bound(keySeed, 1, 100_000_000);
        vm.assume(vm.addr(key) != sponsor);
        PackedUserOperation memory op = _op(address(0x1111), 1, new bytes(65));
        op = _op(address(0x1111), 1, _sign(op, key));
        assertEq(_validate(op, 0.001 ether), 1, "a non-sponsor signature was accepted");
    }

    /// P3: a sponsor signature for one op cannot be replayed onto a different op.
    function testFuzz_noReplay(uint256 nonceB) public {
        vm.assume(nonceB != 1);
        PackedUserOperation memory opA = _op(address(0x1111), 1, new bytes(65));
        bytes memory sigA = _sign(opA, sponsorKey);
        PackedUserOperation memory opB = _op(address(0x1111), nonceB, sigA); // A's sig on B
        assertEq(_validate(opB, 0.001 ether), 1, "a sponsor signature replayed onto another op");
    }

    /// P4: a per-op cost above the ceiling reverts.
    function test_maxCostCeiling() public {
        PackedUserOperation memory op = _op(address(0x1111), 1, new bytes(65));
        op = _op(address(0x1111), 1, _sign(op, sponsorKey));
        uint256 tooHigh = pm.maxCostPerOp() + 1; // read before arming prank + expectRevert
        vm.prank(entryPoint);
        vm.expectRevert(SweepPaymaster.CostTooHigh.selector);
        pm.validatePaymasterUserOp(op, bytes32(0), tooHigh);
    }

    /// P5: disabling the signer (address(0)) rejects every op.
    function test_signerZeroDisables() public {
        pm.setSponsorSigner(address(0));
        PackedUserOperation memory op = _op(address(0x1111), 1, new bytes(65));
        op = _op(address(0x1111), 1, _sign(op, sponsorKey));
        assertEq(_validate(op, 0.001 ether), 1, "sponsorship was live with the signer disabled");
    }
}
