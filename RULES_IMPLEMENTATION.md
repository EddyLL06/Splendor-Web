# Rules implementation

This document maps the supplied base-game rulebook and Version 0 specification
to the implementation. The authoritative rule pipeline lives in
`src/shared/rules/engine.ts`; derived scores, bonuses, eligibility, and payments
live in `src/shared/rules/selectors.ts`.

## Numeric source-data mapping

The CSV convention is used everywhere:

| Index | Color | UI label |
| --- | --- | --- |
| `0` | white | Diamond (`W`) |
| `1` | blue | Sapphire (`B`) |
| `2` | green | Emerald (`G`) |
| `3` | red | Ruby (`R`) |
| `4` | black | Onyx (`K`) |

Gold is a joker token only. It is never a development-card bonus or a normal
gem suit.

The generator skips the second metadata row in each CSV and validates the
declared counts before generating stable IDs.

## Setup

`createInitialState`:

1. validates exactly two to four players;
2. shuffles each development tier independently with boardgame.io’s seeded
   random API;
3. reveals four cards from each tier;
4. shuffles nobles and reveals `players + 1`;
5. creates four, five, or seven tokens per normal color for two, three, or four
   players;
6. always creates five gold jokers; and
7. gives every player empty tokens, cards, reservations, and nobles.

The physical rule gives the youngest player the first turn. Version 0 does not
collect ages, so setup uses boardgame.io’s authoritative random die to choose
the first player. `initialFirstPlayer` is stored in state and used by the custom
turn order.

## Main actions

Exactly one of these actions is accepted while no mandatory resolution is
pending.

### Take three different gems

`takeDifferent` requires exactly three distinct normal colors with at least one
token available in each bank pile. Gold and duplicate colors are rejected.

### Take two matching gems

`takeSame` requires one normal color and at least four tokens in that bank pile
before the action. Exactly two are transferred. Gold is rejected.

### Reserve a development card

`reserveMarket` removes the identified visible card, adds a public reservation,
and refills from the same tier when possible.

`reserveDeck` removes the top card from a non-empty tier, adds a private
reservation, and logs only the tier.

Both actions enforce the three-card reservation limit and transfer one gold
when available. Reservation remains legal when the bank has no gold.

### Purchase a development card

`findPurchasableCard` resolves either a current market card or one of the
acting player’s own reservations. Stale market IDs and another player’s
reservation are rejected.

For every color:

```text
effective cost = max(0, printed cost - permanent bonus count)
```

`analyzePayment` returns:

- the effective cost;
- a normal-colored-token-first suggested payment; and
- every validation error for a proposed payment.

Colored payment cannot exceed the effective cost or owned tokens. Gold must
equal the total remaining unpaid effective cost. This permits a player to
reduce a colored payment and use gold strategically even when they own enough
of that normal color. Negative values, overpayment, missing gold, and unowned
tokens are rejected. A fully discounted card requires a zero payment.

Paid tokens return to the bank. The purchased card immediately contributes its
permanent bonus and prestige. A market purchase refills its tier when possible.

## Turn-resolution order

Every main action passes through this authoritative order:

1. validate and apply the selected main action;
2. refill an affected market slot;
3. count every held token, including gold;
4. if above ten, set a mandatory `discard` resolution;
5. after a legal return, evaluate noble eligibility;
6. automatically award one eligible noble or set mandatory `noble` selection
   when multiple are eligible;
7. derive the player’s final score;
8. trigger or continue final-round handling;
9. mark the turn ready; and
10. let boardgame.io advance to the next player automatically.

Client-triggered framework turn events are disabled. A turn cannot end early,
and a second main action cannot be submitted during a pending resolution.

## Ten-token limit

After token taking or reservation, `totalTokens` counts all six token colors.
When the total exceeds ten, state records the exact overage.

`applyDiscard` accepts only the current player and requires the returned
quantities to be non-negative integers the player owns. Their sum must equal
the exact overage. Any mix of normal gems and gold is legal. Returned tokens go
back to the matching bank piles before noble resolution continues.

## Nobles

`getEligibleNobleIDs` derives bonuses only from purchased development cards.
Tokens and gold never contribute.

- Zero eligible nobles: finish resolution.
- One eligible noble: award it automatically.
- Multiple eligible nobles: require the current player to choose one.

An awarded noble is removed from the public pool and added to the player. No
player can receive more than one noble in a turn.

## End of game and ties

Scores are derived from purchased development cards and noble IDs. When the
completed end of a turn first reaches at least 15 prestige, `finalRound` records
the triggering player.

Each completed turn increments a per-player turn count. The game ends only when
all turn counts are equal, which correctly handles a trigger by the first,
middle, or last player without granting an extra turn.

Final standings use:

1. highest prestige score;
2. among tied scores, fewest purchased development cards; and
3. if both values are still tied, every tied player is a shared winner.

The third step is a documented digital interpretation: the printed rulebook
defines no further tiebreak, so Version 0 does not invent one.

## Invalid moves and state safety

Pure rule helpers clone the JSON-serializable game state only after validation
passes and return structured errors otherwise. The boardgame.io integration
returns `INVALID_MOVE` for a rejected result, leaving the authoritative state
unchanged.

Validation covers active player, pending resolution, bank quantities, action
shape, reservation limits, deck and market presence, card ownership, payment,
discard quantities, noble eligibility, stale IDs, completed turns, and game
over.

## Hidden information

The server always retains real deck order. `playerView` replaces every future
card ID with an identical opaque value, so clients receive deck counts but not
future identities.

A blind reservation’s owner receives its card ID; all other players receive a
`null` ID and only its tier. A reservation that came from the visible market
stays public. Public logs say only that a hidden card of a tier was reserved.

## Other digital adaptations

- The app uses a room display name instead of collecting age.
- Token and card components use labeled CSS shapes and text rather than
  physical or official artwork.
- In-memory match storage intentionally resets with the server.
- Credentials are tab-local and never appear in invite URLs.
- A game begins after all configured lobby seats have display names.
