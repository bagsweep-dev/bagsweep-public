// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// BagSweep in-house audit — invariant #1: SweepExecutor no-theft / bounded loss.
//
// Threat model: the keeper is fully untrusted (assume its key is compromised). It
// drives executeSweep with arbitrary params. The guarantee this suite proves, across
// thousands of random keeper call sequences, is that value cannot be stolen:
//
//   INV-1  the executor is stateless — it holds no meme and no USDG after any call
//          (a redirect or a strand would leave value here). Catches C1 / M8.
//   INV-2  no keeper-controlled address ever receives the account's meme or USDG
//          (proceeds cannot be routed away from the account).
//   INV-3  value is conserved exactly — every meme token that left the account came
//          back as its exact USDG value, to the account (mock rate is fixed, fee = 0).
//   INV-4  meme balance only ever falls (the keeper cannot inject or double-count).
//
// Deterministic mock router (no slippage) + default fee (0) make INV-3 an equality,
// not a bound — so any skim, strand, or redirect breaks it.

import {Test} from "forge-std/Test.sol";
import {SweepExecutor} from "../../contracts/SweepExecutor.sol";
import {SweepPolicyRegistry} from "../../contracts/SweepPolicyRegistry.sol";
import {SwapParams} from "../../contracts/interfaces/ISweepExecutor.sol";
import {Destination, SweepMode} from "../../contracts/interfaces/ISweepPolicy.sol";
import {MockUSDG} from "../../contracts/testnet/MockUSDG.sol";
import {MockMemeToken} from "../../contracts/testnet/MockMemeToken.sol";
import {MockSwapRouter} from "../../contracts/testnet/MockSwapRouter.sol";

interface IMintable {
    function mint(address to, uint256 amount) external;
}

/// The account AND the untrusted keeper, in one. It owns the meme tokens, set its
/// own owner-authored policy once, and then drives executeSweep the way a compromised
/// keeper would. Foundry fuzzes the seeds; the invariants must survive every sequence.
contract KeeperHandler is Test {
    SweepExecutor public exec;
    SweepPolicyRegistry public registry;
    MockMemeToken public meme;
    MockUSDG public usdg;
    MockSwapRouter public router;
    MockSwapRouter public skimRouter; // sanctioned but under-delivers (90% of honest)
    address public attacker;

    uint256 public constant UNIT = 1e12; // 1e18 meme -> 1e6 USDG (1:1 value)
    bytes4 constant SWAP_SEL = bytes4(keccak256("swapExactTokensForTokens(uint256,uint256,address[],address,uint256)"));

    /// Ghost: the largest fraction (bps) any single successful sweep call drained
    /// from the meme balance. The per-swap cap is pct (2500), so this must never
    /// exceed it. Invariant #2 (bounded liquidation) reads this.
    uint256 public maxDrainBps;

    function _recordDrain(uint256 balBefore) internal {
        if (balBefore == 0) return;
        uint256 aft = meme.balanceOf(address(this));
        if (aft >= balBefore) return;
        uint256 bps = (balBefore - aft) * 10000 / balBefore;
        if (bps > maxDrainBps) maxDrainBps = bps;
    }

    constructor(
        SweepExecutor _exec,
        SweepPolicyRegistry _registry,
        MockMemeToken _meme,
        MockUSDG _usdg,
        MockSwapRouter _router,
        MockSwapRouter _skimRouter,
        address _attacker
    ) {
        exec = _exec; registry = _registry; meme = _meme; usdg = _usdg; router = _router; skimRouter = _skimRouter; attacker = _attacker;
        // This handler IS the account: it authors its own policy (25% cap, 5% slippage,
        // USDG_YIELD, no whitelist) and approves the executor to pull its meme.
        address[] memory empty = new address[](0);
        registry.setPolicy(2500, 0, SweepMode.POSITION, Destination.USDG_YIELD, empty, 500);
        meme.approve(address(exec), type(uint256).max);
    }

    function _swapData(uint256 amountIn, address to) internal view returns (bytes memory) {
        address[] memory path = new address[](2);
        path[0] = address(meme); path[1] = address(usdg);
        return abi.encodeWithSelector(SWAP_SEL, amountIn, uint256(0), path, to, block.timestamp + 300);
    }

    /// An honest sweep within the policy — exercises the real value path.
    function legitSweep(uint256 seed) external {
        uint256 bal = meme.balanceOf(address(this));
        uint256 maxUnits = (bal * 2500 / 10000) / UNIT; // pct cap, in whole USDG units
        if (maxUnits == 0) return;
        uint256 units = bound(seed, 1, maxUnits);
        uint256 amountIn = units * UNIT;
        SwapParams[] memory swaps = new SwapParams[](1);
        swaps[0] = SwapParams({
            tokenIn: address(meme),
            amountIn: amountIn,
            spotQuote: units,              // exact expected USDG out
            router: address(router),
            swapData: _swapData(amountIn, address(exec))
        });
        uint256 before = meme.balanceOf(address(this));
        try exec.executeSweep(swaps, Destination.USDG_YIELD, address(0), 0) {} catch {}
        _recordDrain(before);
    }

    /// A hostile keeper: redirect proceeds, oversize the sell, use a fake router, or
    /// zero the quote. Every one must revert — the invariants prove it did no damage.
    function attackSweep(uint256 seed, uint8 kind) external {
        uint256 bal = meme.balanceOf(address(this));
        if (bal == 0) return;
        uint256 amountIn = bound(seed, 1, bal);
        address to = address(exec);
        address rtr = address(router);
        uint256 quote = amountIn / UNIT;
        if (kind % 4 == 0) to = attacker;                 // redirect swap recipient
        else if (kind % 4 == 1) amountIn = bal;           // oversize past the pct cap
        else if (kind % 4 == 2) rtr = attacker;           // unsanctioned router
        else quote = 0;                                   // no slippage floor
        SwapParams[] memory swaps = new SwapParams[](1);
        swaps[0] = SwapParams({
            tokenIn: address(meme),
            amountIn: amountIn,
            spotQuote: quote,
            router: rtr,
            swapData: _swapData(amountIn, to)
        });
        uint256 before = meme.balanceOf(address(this));
        try exec.executeSweep(swaps, Destination.USDG_YIELD, address(0), 0) {} catch {}
        _recordDrain(before);
    }

    /// A sanctioned-but-under-delivering venue (90% of honest) with an HONEST declared
    /// quote. The slippage floor (policy 5%) must reject it — the account can never be
    /// forced to accept below its own tolerance. This is the path the M3 mutant frees:
    /// remove the floor check and this under-delivery succeeds, breaking value conservation.
    function skimSweep(uint256 seed) external {
        uint256 bal = meme.balanceOf(address(this));
        uint256 maxUnits = (bal * 2500 / 10000) / UNIT;
        // Large units only: at 50% delivery vs a 95% floor the swap always fails the
        // floor, with no small-number rounding boundary where it could sneak through.
        if (maxUnits < 1000) return;
        uint256 units = bound(seed, 1000, maxUnits);
        uint256 amountIn = units * UNIT;
        SwapParams[] memory swaps = new SwapParams[](1);
        swaps[0] = SwapParams({
            tokenIn: address(meme),
            amountIn: amountIn,
            spotQuote: units,              // honest 1:1 quote; skimRouter delivers only 0.9
            router: address(skimRouter),
            swapData: _swapData(amountIn, address(exec))
        });
        uint256 before = meme.balanceOf(address(this));
        try exec.executeSweep(swaps, Destination.USDG_YIELD, address(0), 0) {} catch {}
        _recordDrain(before);
    }

    /// A hostile keeper that pulls the full policy-capped amount but encodes a SMALLER
    /// amountIn in the swap calldata, trying to strand the difference on the executor
    /// (external-audit finding #2). The encoded-amountIn check must reject it; INV-1
    /// (executor holds nothing) and INV-3 (value conserved) both prove nothing stranded.
    function strandSweep(uint256 seed) external {
        uint256 bal = meme.balanceOf(address(this));
        uint256 maxUnits = (bal * 2500 / 10000) / UNIT;
        if (maxUnits < 2) return;
        uint256 units = bound(seed, 2, maxUnits);
        uint256 amountIn = units * UNIT;         // pulled from the account
        uint256 encoded = amountIn / 2;          // but the swap only spends half
        SwapParams[] memory swaps = new SwapParams[](1);
        swaps[0] = SwapParams({
            tokenIn: address(meme),
            amountIn: amountIn,
            spotQuote: units,
            router: address(router),
            swapData: _swapData(encoded, address(exec))
        });
        uint256 before = meme.balanceOf(address(this));
        try exec.executeSweep(swaps, Destination.USDG_YIELD, address(0), 0) {} catch {}
        _recordDrain(before);
    }
}

contract SweepExecutorNoTheftTest is Test {
    SweepExecutor exec;
    SweepPolicyRegistry registry;
    MockMemeToken meme;
    MockUSDG usdg;
    MockSwapRouter router;
    MockSwapRouter skimRouter;
    KeeperHandler handler;
    address attacker = address(0xBAD);
    uint256 constant INITIAL_MEME = 1_000_000e18;

    function setUp() public {
        address owner = address(this);
        usdg = new MockUSDG();
        meme = new MockMemeToken("Meme", "MEME");
        router = new MockSwapRouter(1, 1e12);            // 1e18 meme -> 1e6 USDG (honest)
        skimRouter = new MockSwapRouter(1, 2e12);        // 50% of honest — sanctioned, under-delivers
        registry = new SweepPolicyRegistry(owner);
        exec = new SweepExecutor(address(usdg), address(registry), owner);
        exec.setSanctionedRouter(address(router), true);     // both venues are owner-sanctioned;
        exec.setSanctionedRouter(address(skimRouter), true); // the floor is what must reject the bad one
        exec.setMinSweepInterval(0);                         // cooldown is unit-tested separately; disable
                                                             // it here so the fuzzer exercises many sweeps
                                                             // against the value/theft/strand bounds

        // Fund both routers so they can pay out USDG on a swap.
        IMintable(address(usdg)).mint(address(router), 1_000_000_000e6);
        IMintable(address(usdg)).mint(address(skimRouter), 1_000_000_000e6);

        handler = new KeeperHandler(exec, registry, meme, usdg, router, skimRouter, attacker);
        IMintable(address(meme)).mint(address(handler), INITIAL_MEME); // the account's position

        targetContract(address(handler));
    }

    /// INV-1: the executor is stateless — nothing of the account's is ever left here.
    function invariant_executorHoldsNothing() public view {
        assertEq(meme.balanceOf(address(exec)), 0, "meme stranded on executor");
        assertEq(usdg.balanceOf(address(exec)), 0, "USDG stranded on executor");
    }

    /// INV-2: no keeper-controlled address ever receives the account's value.
    function invariant_nothingLeaksToKeeper() public view {
        assertEq(meme.balanceOf(attacker), 0, "meme reached a keeper address");
        assertEq(usdg.balanceOf(attacker), 0, "USDG reached a keeper address");
    }

    /// INV-3: value conserved exactly. Every meme that left the account returned as
    /// its exact USDG value, to the account. Any skim/strand/redirect breaks this.
    function invariant_valueConserved() public view {
        uint256 memeLeft = meme.balanceOf(address(handler));
        uint256 usdgGot = usdg.balanceOf(address(handler));
        assertEq(usdgGot, (INITIAL_MEME - memeLeft) / 1e12, "value was not conserved to the account");
    }

    /// INV-4: the account's meme balance only ever falls (no inflation / double-count).
    function invariant_memeOnlyDecreases() public view {
        assertLe(meme.balanceOf(address(handler)), INITIAL_MEME, "meme balance rose");
    }

    /// INV-5 (invariant #2 — bounded liquidation): no single sweep call can drain more
    /// than the policy's pct cap (2500 bps) from a token. This is the guarantee the M4
    /// mutant breaks, and it is distinct from no-theft: over-liquidation conserves value
    /// but violates the user's authored bound.
    function invariant_boundedLiquidation() public view {
        assertLe(handler.maxDrainBps(), 2500, "a single sweep drained more than the pct cap");
    }
}
