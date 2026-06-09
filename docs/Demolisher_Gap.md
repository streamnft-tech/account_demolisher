https://github.com/stellar-expert/stellar-expert-explorer/blob/master/ui/business-logic/demolisher/demolisher-tx-builder.js

| Missing flow to add | Why it matters |
|---|---|
| Mediator merge transaction | Required for CEX/exchange destinations that cannot receive `ACCOUNT_MERGE`. |
| Memo support on final payout | Required by many exchanges. |
| Bulk “sell all eligible classic assets” step | Current UI is per-asset; demolisher flow should optionally run through all assets. |
| Bulk “return unsold assets to issuer + remove trustline” step | Current UI supports this per trustline, but not as an account-wide phase. |
| Multi-secret / multi-signer signing | Needed for multisig accounts and matches stellar.expert’s signer-array model. |
| Staged loop with refresh after each tx | Avoids stale sequence/state and makes demolish feel like a guided process. |
| Deleted issuer / failed sell recovery | Needed when assets cannot be sold or issuer account is gone. |

## Current implementation notes

- The scan page is now a guided cleanup workspace rather than a raw checklist. Results are grouped into **Unlock value**, **Account states**, **Open offers & DeFi tools**, and **Close safely**.
- Trustlines and sponsorships use visible row details with scoped action buttons. Account control and threshold findings now follow the same row-detail pattern.
- Sponsorship rows show estimated XLM reserve and Horizon-discoverable sponsored entries. Sponsored data entries may still be invisible until action prep/manual follow-up.
- Native XLM balance is displayed inside the account-health snapshot and remains separate from estimated reserve release.
