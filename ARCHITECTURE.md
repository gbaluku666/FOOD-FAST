# Architecture (v2)

Flutter Android app
   | HTTPS, one POST endpoint: { action, token, ...params }
   v
Google Apps Script web app (backend/Code.gs)
   |-- Google Sheet = database (Menu, Combos, Stations, Settings, Orders, OrderItems,
   |                            Inventory, StockMovements, Users, Customers, Audit)
   '-- Google Drive = food pictures (links only in the sheet)

- Auth: username + password (salted, iterated SHA-256) -> session token cached 6 h; the account
  is re-checked on every request so disabling a user works immediately.
- Roles: admin, manager, kitchen, waiter, delivery (checked per action in HANDLERS).
- Order state machine (enforced by the script):
  Pending -> Approved -> Cooking -> Ready -> Assigned -> Completed
  side exits: Rejected, Cancelled, Failed (delivery)
- Customers need no account; they follow up with order number + phone.
- Statistics are computed from Completed orders (sales, orders, servings by day / month / year).
- Not yet built: automatic payment collection (Mobile Money API), push notifications,
  WhatsApp sending, recipe-based stock deduction.


---
## v3 additions
* `lib/main.dart` - original screens and API client (logic unchanged) + new theme hook-up.
* `lib/brand.dart` - theme, sliding background, logo header, notification service/watcher.
* `lib/stock.dart` - stock overview + graphs, add stock, items used, history, background gallery.
* `lib/delivery.dart` - delivery man jobs, customer-code check-in and confirmation.
* Backend sheets: `Inventory` (+pack/price/level columns), `StockMovements` (+kind/cost/balance),
  `Orders` (+code, codeUsed, deliveryNote, amountCollected), new `Notifications`.
* Stock is stored in the item's base unit; packs are converted with `packSize`.
* A delivery code is valid once: it dies on confirm, failure, cancellation or manager override.
