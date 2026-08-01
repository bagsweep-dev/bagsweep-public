// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// BagSweep in-house audit — invariant #3: SweepBuyback no-exit.
//
// Guarantee: USDG (the accumulated fee pool) can leave the contract ONLY by being
// swapped for $SWEEP and burned to DEAD. There is no owner withdrawal, USDG/$SWEEP
// cannot be rescued, and the buyback output is measured and burned in the same call.
// The keeper is untrusted: it can time/route buybacks but can never extract value.
//
//   INV-1  no keeper/owner/attacker address ever holds USDG (the pool can't be pulled)
//   INV-2  no keeper/owner/attacker address ever holds $SWEEP (output can't be redirected)
//   INV-3  DEAD's $SWEEP balance only ever grows (every buyback output is burned)
//   INV-4  a single buyback spends at most maxSpendBps of the balance (bounded bleed)
//
// Plus two unit checks: the owner cannot rescue USDG or $SWEEP.

import {Test} from "forge-std/Test.sol";
import {SweepBuyback} from "../../contracts/SweepBuyback.sol";
import {MockUSDG} from "../../contracts/testnet/MockUSDG.sol";
import {MockMemeToken} from "../../contracts/testnet/MockMemeToken.sol";
import {MockSwapRouter} from "../../contracts/testnet/MockSwapRouter.sol";

interface IMintable { function mint(address to, uint256 amount) external; }

address constant DEAD = 0x000000000000000000000000000000000000dEaD;

/// The untrusted keeper. Drives buybackAndBurn with honest and hostile params.
contract BuybackKeeper is Test {
    SweepBuyback public bb;
    MockUSDG public usdg;
    MockMemeToken public sweep;
    MockSwapRouter public router;
    address public attacker;
    bytes4 constant SWAP_SEL = bytes4(keccak256("swapExactTokensForTokens(uint256,uint256,address[],address,uint256)"));

    uint256 public maxSpendObservedBps; // ghost: largest single-call spend fraction

    constructor(SweepBuyback _bb, MockUSDG _usdg, MockMemeToken _sweep, MockSwapRouter _router, address _attacker) {
        bb = _bb; usdg = _usdg; sweep = _sweep; router = _router; attacker = _attacker;
    }

    function _swapData(uint256 amountIn, address to) internal view returns (bytes memory) {
        address[] memory path = new address[](2);
        path[0] = address(usdg); path[1] = address(sweep);
        return abi.encodeWithSelector(SWAP_SEL, amountIn, uint256(0), path, to, block.timestamp + 300);
    }

    function buyback(uint256 amtSeed, uint8 kind) external {
        uint256 pool = usdg.balanceOf(address(bb));
        uint256 maxSpend = pool * 2000 / 10000; // maxSpendBps default
        if (maxSpend == 0) return;
        uint256 amount = bound(amtSeed, 1, maxSpend);
        address to = address(bb);
        address rtr = address(router);
        uint256 minOut = amount * 1e12; // honest 1:1 (USDG 6dp -> SWEEP 18dp)
        if (kind % 5 == 1) to = attacker;             // redirect the SWEEP output
        else if (kind % 5 == 2) rtr = attacker;       // unsanctioned router
        else if (kind % 5 == 3) amount = pool;        // oversize past the spend cap
        else if (kind % 5 == 4) minOut = 0;           // no slippage floor

        uint256 before = usdg.balanceOf(address(bb));
        try bb.buybackAndBurn(amount, minOut, rtr, _swapData(amount, to)) {
            uint256 spent = before - usdg.balanceOf(address(bb));
            if (before > 0) {
                uint256 bps = spent * 10000 / before;
                if (bps > maxSpendObservedBps) maxSpendObservedBps = bps;
            }
        } catch {}
    }

    /// Anyone may sweep stray $SWEEP to DEAD; exercise it too.
    function burnStuck() external { try bb.burnStuckSweep() {} catch {} }
}

contract SweepBuybackNoExitTest is Test {
    SweepBuyback bb;
    MockUSDG usdg;
    MockMemeToken sweep;
    MockSwapRouter router;
    BuybackKeeper keeper;
    address owner = address(this);
    address attacker = address(0xBAD);
    uint256 constant FEE_POOL = 1_000_000e6; // accumulated USDG fees

    function setUp() public {
        usdg = new MockUSDG();
        sweep = new MockMemeToken("Sweep", "SWEEP");
        router = new MockSwapRouter(1e12, 1); // 1e6 USDG -> 1e18 SWEEP (1:1 value)

        keeper = new BuybackKeeper(bb, usdg, sweep, router, attacker); // placeholder; rewired below
        bb = new SweepBuyback(address(usdg), owner, address(keeper));
        keeper = new BuybackKeeper(bb, usdg, sweep, router, attacker);
        bb.setKeeper(address(keeper));

        bb.setSweepToken(address(sweep));
        bb.setSanctionedRouter(address(router), true);
        bb.setCooldown(0); // let the fuzzer run many buybacks; the per-call spend cap still bounds each

        IMintable(address(usdg)).mint(address(bb), FEE_POOL);      // the fee pool to protect
        IMintable(address(sweep)).mint(address(router), 1e30);     // router can pay out SWEEP

        targetContract(address(keeper));
    }

    /// INV-1: the pool can never be pulled to any keeper/owner/attacker address.
    function invariant_noUsdgExtracted() public view {
        assertEq(usdg.balanceOf(address(keeper)), 0, "USDG reached the keeper");
        assertEq(usdg.balanceOf(owner), 0, "USDG reached the owner");
        assertEq(usdg.balanceOf(attacker), 0, "USDG reached an attacker");
    }

    /// INV-2: buyback output can never be redirected to a keeper/owner/attacker.
    function invariant_noSweepRedirected() public view {
        assertEq(sweep.balanceOf(address(keeper)), 0, "SWEEP reached the keeper");
        assertEq(sweep.balanceOf(owner), 0, "SWEEP reached the owner");
        assertEq(sweep.balanceOf(attacker), 0, "SWEEP reached an attacker");
    }

    /// INV-3: every unit of $SWEEP the buyback ever produced is at DEAD (only exit is burn).
    /// The contract itself may transiently hold 0; DEAD only grows.
    function invariant_outputOnlyBurned() public view {
        // All SWEEP that ever left the router went to DEAD or is dust on the bb (burnable).
        uint256 atDead = sweep.balanceOf(DEAD);
        uint256 onBb = sweep.balanceOf(address(bb));
        uint256 routerLeft = sweep.balanceOf(address(router));
        assertEq(atDead + onBb + routerLeft, 1e30, "SWEEP escaped the burn path");
    }

    /// INV-4: a single buyback spends at most maxSpendBps (2000) of the pre-call balance.
    function invariant_boundedBleed() public view {
        assertLe(keeper.maxSpendObservedBps(), 2000, "a buyback spent more than the cap");
    }

    // ── unit: the owner cannot rescue the protocol assets ──
    function test_ownerCannotRescueUsdg() public {
        vm.expectRevert(SweepBuyback.CannotRescueProtocolAsset.selector);
        bb.rescue(address(usdg), 1, owner);
    }
    function test_ownerCannotRescueSweep() public {
        vm.expectRevert(SweepBuyback.CannotRescueProtocolAsset.selector);
        bb.rescue(address(sweep), 1, owner);
    }
}
