# Kanyatsi Restaurant — extended build

Flutter Android app + Google Apps Script / Google Sheets backend. This update is additive: it retains the existing ordering, menu, inventory, staff login, audit, and delivery workflow and adds feature-specific records and actions without deleting existing order rows.

## Preserve network and file access

- Keep the `kApiUrl` value in `lib/main.dart` unchanged unless you deliberately deploy a different Apps Script web app URL.
- `Api.call` keeps its explicit redirect handling for Google Apps Script POST responses and its timeout/error handling.
- The Android build workflow keeps `INTERNET`, `CAMERA`, `POST_NOTIFICATIONS`, `READ_MEDIA_IMAGES`, and the legacy gallery permission limited to Android 12 and below. Image picking remains available; screenshots and profile pictures are uploaded to Drive with a size limit.
- Do not remove the `assets/`, `lib/`, `backend/`, or `.github/workflows/` folders from the repository.

## Deploy the backend safely

1. Make a copy of the Google Sheet used by the current live deployment before changing it.
2. Open its Apps Script project and replace `Code.gs` with `backend/Code.gs` from this package.
3. Run `setupSheets` from the Apps Script editor and approve the requested Sheets, Drive, Mail, Slides, and outbound HTTPS permissions. The setup adds new tabs/columns while preserving existing data. It creates and trashes a temporary Slides file solely to authorize reporting scopes.
4. Deploy > Manage deployments > Edit > select **New version** > Deploy. Keep **Execute as: Me** and the access setting currently used by your app. Keep the existing `/exec` URL.
5. Run a smoke test on a copy of the sheet first: staff login, customer order, image upload, table-code validation, Mobile Money proof, cash handover, wallet top-up, feature request approval, and report export.

## Added workflows

- Manager/admin feature center for kitchen item requests, stock requests, event listings and bookings, subscription packages and purchases, payment instructions, Airtel/MTN instructions, wallet top-ups, token rules/redemption, restaurant details, service numbers and social links.
- Customer accounts use phone number and password; profile picture upload, order history, event/package browsing, wallet balance and token balance are exposed in the customer portal.
- Airtel Money and MTN selection, transaction ID or screenshot upload, and manager approval before an order is marked paid. A screenshot is supporting evidence, not proof that the transfer cleared; the manager must verify it against the payment provider.
- Wallet payment checks the authenticated customer's balance and deducts it at order creation. Cancelling a wallet-paid order refunds its balance. Wallet top-ups remain pending until a manager confirms receipt.
- Indoor cash orders have a customer order code. The assigned waiter records collection after collecting cash; the manager must enter the matching code when the cash is physically handed over. Indoor cash orders cannot be marked paid/completed before manager reconciliation.
- Manager-generated six-digit table codes, with an option to disable code requirements. Both the table selection and backend order creation validate the selected table's code.
- Daily staff availability and least-completed-task auto-allocation for waiter/delivery assignments. Completed assignments update the daily workload counters.
- Event booking and subscription purchase codes are issued only after a manager confirms payment; waiters/managers can check event codes. Subscription meal-use requests require an active confirmed subscription and issue a code for the waiter to check.
- Admin-configurable loyalty reward rules use `5000-7000=5` (minimum bill–maximum bill=number of tokens) in a token reward record's title or details. Tokens are awarded on completed orders for registered customers; redemptions require manager confirmation.
- Monthly report export creates an Excel workbook with order details, staff performance and the previous three months' sales/order comparisons, plus a PowerPoint (`.pptx`) presentation. Google Sheets/Slides source links are also returned.
- Food-menu background transitions use only images added by the manager; there are no bundled slideshow defaults.

## Push notifications when the app is closed

The current app's role-based notification queue and in-app/local notifications remain available while the app is running. True remote push after Android has fully closed the app **requires a Firebase project**, Android `google-services.json`, Firebase Cloud Messaging setup and server credentials/token registration. Those project-specific credentials are not included in the uploaded source, so do not treat closed-app push as enabled until FCM is configured and tested on a physical device.

## Build APK

Push the complete project to the repository's `main` branch or run **Actions → Build Kanyatsi Restaurant APK → Run workflow**. Download the APK from the successful workflow's Artifacts. The build workflow generates Android platform files if needed and retains network, camera, media and notification permissions.

## Important deployment notes

- This environment did not have Flutter/Dart installed, so a Flutter compile and physical-device integration test could not be run here. Backend JavaScript syntax and YAML configuration were checked; a CI build and test against a copied Google Sheet are still required before replacing the live app.
- External provider credentials, live payment confirmation, social media URLs and restaurant contact details must be entered by an authorized admin/manager. Payment codes are configuration data; the app does not independently query MTN/Airtel settlement APIs.
- Keep the Google Sheet and uploaded payment/profile images restricted to the appropriate business account. The current Drive upload links are viewable by anyone with the link so the app can display them; do not upload sensitive documents through this image feature.
