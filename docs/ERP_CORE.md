# AlMahasibPro ERP Core

This branch rebuilds the product around one transactional ERP core while preserving the existing tenant, authentication and offline-capable infrastructure.

## Accounting contract

Every posted business document is immutable. Corrections are posted as reversals/returns, never destructive edits.

Every company has exactly one base accounting currency: IQD or USD. Sales, purchases, inventory valuation and the general ledger are posted in that currency. Cross-currency cash settlement records both the physical cash amount/currency and the base-currency accounting amount using the company-approved USD/IQD rate snapshot.

The general ledger is the accounting source of truth. Stock quantities and weighted average cost are changed only by posted inventory documents. Customer and supplier balances derive from posted documents and settlements.

## Posting flow

1. Validate tenant, role, document number, currency, party, warehouse and item.
2. Validate stock for outbound documents.
3. Calculate immutable totals and inventory cost.
4. Post stock movement.
5. Post balanced journal entry.
6. Persist the document and audit/change event in the same SQLite transaction.
7. Return acknowledgement only after durable commit.

## Core modules

Company and permissions -> chart/ledger -> parties -> catalog/units -> warehouses -> purchases -> sales -> cash/bank settlement -> returns/transfers -> reports.

No demo seeders or direct stock mutation belong in production flows.
