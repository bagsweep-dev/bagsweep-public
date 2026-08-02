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

Robinhood Chain has no price oracle and no usable on-chain TWAP. Because of that, the keeper
declares the reference price for each sweep, and the on-chain slippage floor is derived from
that declared price. **A compromised keeper can declare an artificially low price and route a
sweep through a manipulated or sandwiched pool, extracting value from that sweep.**

This is bounded, not unbounded. The keeper can never sweep more than the **percentage cap you
authored** per cooldown interval, and can never touch tokens outside your policy or reach your
account directly. So the worst case is losing up to your authored percentage of a position's
value per interval, never your whole account, and your owner key can always exit.

We cannot remove this on Robinhood Chain without an oracle, so we disclose it plainly rather
than imply a protection that does not exist. To limit your exposure: author a conservative
percentage cap, treat the keeper as untrusted, and exit via your owner key if you ever suspect
the keeper is compromised. This tradeoff is inherent to hands-off take-profit automation on an
oracle-less chain.

## Safe harbor

We will not pursue legal action against good-faith research that follows this policy,
avoids privacy violations and service disruption, and gives us a reasonable opportunity
to remediate before any public disclosure.

## Disclosure

Coordinated disclosure only: please keep details private until a fix is deployed. We're
glad to credit you once it is.
