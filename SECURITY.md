# Security Policy

## Reporting a vulnerability

Please report security issues **privately**. Do not open a public issue or pull request,
and do not exploit an issue beyond what is needed to demonstrate it.

**Contact**
- Telegram: https://t.me/bagsweep
- X (DM): https://x.com/bagsweep

Include a description, the affected contract or component, and reproduction steps or a
proof of concept. We aim to acknowledge within 72 hours and will coordinate a fix and a
disclosure timeline with you.

## Scope

BagSweep is **not yet on mainnet**. The contracts have been internally hardened (invariant
and mutation testing) and externally reviewed, but should not be treated as production-ready
until launch. Reports against the on-chain contracts in `contracts/contracts/` are the most
valuable; the off-chain keeper and the read-only tracker are secondary.

## Trust model

BagSweep is non-custodial: your keys stay yours. Your smart account holds your own tokens,
and your owner key can always exit directly (`ownerExecute`), independent of the keeper, the
bundler, or the paymaster. The off-chain keeper is **untrusted by design** and is bounded
on-chain: it can only execute the sweep policy you authored (which token, what percentage,
where the proceeds go). It can never move funds outside that policy, redirect proceeds away
from your account, or seize your account.

## Known limitation: keeper-declared pricing (please read before using)

Robinhood Chain has no external price oracle (Pyth and Chainlink are both absent). Because of
that, the keeper declares the reference price for each sweep, and the on-chain slippage floor is
derived from that declared price. **A compromised keeper can declare an artificially low price
and route a sweep through a manipulated or sandwiched pool, extracting value from that sweep.**

This applies to **both swap legs**: the meme-to-USDG swap, and for STOCKS or SPLIT_50_50
destinations the USDG-to-stock swap, which is bounded by a keeper-declared stock quote the
same way. Both are capped by your policy percentage; neither is protected on execution price.

This is bounded, not unbounded. The keeper can never sweep more than the **percentage cap you
authored** per cooldown interval, and can never touch tokens outside your policy or reach your
account directly. So the worst case is losing up to your authored percentage of a position's
value per interval, never your whole account, and your owner key can always exit.

**Partial mitigation added 2026-08-09 (off-chain, defence in depth).** We previously stated that
this chain had no usable on-chain TWAP at all. That was measured and found to be **wrong for the
pools that matter**: live Uniswap V3 launchpad pools do carry observation buffers (WOOF/aeWETH and
MANCER/aeWETH both read observation-cardinality 1400, and `observe()` over a 30-minute window
succeeds), while unprovisioned pools read 1. The keeper now runs a TWAP gate (`keeper/src/twap.js`)
before building a sweep: it requires a minimum observation cardinality, requires the pool to be old
enough to cover the full window, and requires a fast and a slow window to agree with each other and
with spot inside a deviation cap. A pool being dumped to depress the quote fails that check and the
sweep is skipped rather than executed.

Be precise about what this does and does not change. The gate decides **whether** to sweep; it does
not price anything, and the on-chain floor is still the keeper-declared `spotQuote`. It is enforced
**off-chain**, so it constrains an honest keeper facing a manipulated market — it is **not** a
defence against a compromised keeper, which can simply skip the check. The on-chain bound remains
the percentage cap. Tokens whose pools have no observation buffer (including $SWEPT's own pool at
the time of writing) cannot be gated at all.

We cannot remove the underlying limitation on Robinhood Chain without an oracle, so we disclose it
plainly rather than imply a protection that does not exist. To limit your exposure: author a
conservative percentage cap, treat the keeper as untrusted, and exit via your owner key if you ever
suspect the keeper is compromised. This tradeoff is inherent to hands-off take-profit automation on
a chain with no external oracle.

## Legal perimeter (what this software is, and what has not been established)

This section exists so that nobody has to infer our legal posture from marketing copy. It is a
factual description of the software and of what is **not** yet determined. It is not legal advice,
not a legal opinion, and not a classification of any asset.

**What the protocol does.** BagSweep is non-custodial automation. You deploy a smart account you
own, you author a policy, and a keeper may execute sweeps within the bounds that policy sets. The
protocol never takes custody: `ownerExecute` lets your owner key move funds directly with no
dependency on the EntryPoint, a bundler, a paymaster, or the keeper. There is no deposit-taking, no
pooled fund, no discretionary management of anyone's assets, and no promise about the value or
performance of any token you sweep into or out of.

**What $SWEPT is, mechanically.** $SWEPT is a fixed-supply token. When the fee switch is enabled,
`SweepExecutor` skims a protocol fee in USDG into `SweepBuyback`, and that USDG can leave only by
being swapped for $SWEPT and burned to `0x…dEaD`. There is no owner withdrawal path and `rescue()`
reverts on both USDG and $SWEPT, so the burn is enforced by the contract rather than promised. Read
that mechanically and not as a claim about value: a burn reduces supply, it does not create a
dividend, a distribution, a revenue share, a profit interest, or any entitlement to protocol funds.
**Holding $SWEPT confers no right to protocol revenue, no governance right over user funds, and no
claim on any BagSweep entity.**

**What has NOT been established.** As of this revision the repository contains no completed legal
classification opinion for $SWEPT or for the protocol, no identified offeror or home jurisdiction
for any public offer, no securities, commodities, money-transmission, or tax analysis, no
regulatory filing or notification, and no authorized-service-provider perimeter. A token being
called a utility token, a fee token, or a burn token does not by itself determine its
classification; that follows the actual rights and economic substance under the law of each
jurisdiction where it is offered or promoted. Nothing here asserts a conclusion on any of that.

**Launch gates that are legal, not technical.** Separately from the engineering gates in
`MAINNET_RUNBOOK.md`, the following remain open and are treated as blocking for anything
value-bearing: qualified counsel review of $SWEPT and of the fee and buyback mechanism; the
jurisdictions in which the interface may be offered or promoted, and any exclusions; consumer, tax,
and accounting treatment of protocol fees; and whether any public communication about fees, burns,
or the demand gate requires separate review before publication. Enabling `setFeeBps` is the point
at which these stop being theoretical.

**Communication discipline we hold ourselves to.** We separate software access from investment
opportunity, mechanism from outcome, and testnet from mainnet. We do not describe the burn as yield,
income, or a return; we do not present sweep automation as financial advice or as a strategy
expected to be profitable; and we do not promise that any sweep executes, that any price is
achieved, or that the keeper is available. Take-profit automation can lose money, and on a chain
with no external oracle it carries the specific execution risk described above.

**Not an offer.** This repository and its documentation are published as source-available technical
material for review and independent verification. Nothing in it is an offer or solicitation to buy
or sell any asset, an invitation to invest, or a recommendation. See `LICENSE` for what use is
permitted.

## Safe harbor

We will not pursue legal action against good-faith research that follows this policy,
avoids privacy violations and service disruption, and gives us a reasonable opportunity
to remediate before any public disclosure.

## Disclosure

Coordinated disclosure only: please keep details private until a fix is deployed. We're
glad to credit you once it is.
