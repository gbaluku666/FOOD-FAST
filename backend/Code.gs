/**
 * KANYATSI RESTAURANT - Google Sheets backend (Google Apps Script) v3
 *
 * The Google Sheet this script is attached to IS the database.
 * The Flutter app talks to this script as a JSON web API.
 *
 * SETUP (once):
 *  1. Create a Google Sheet. Open Extensions > Apps Script.
 *  2. Paste this whole file into Code.gs and save.
 *  3. Select the function  setupSheets  and press Run. Accept ALL permission
 *     prompts (Sheets, Drive for food pictures, Gmail for password-reset emails).
 *     It creates the tabs and a first admin:  admin / Admin@1234
 *     (the app forces a password change at first sign-in).
 *  4. Deploy > New deployment > type "Web app"
 *       Execute as: Me      Who has access: Anyone
 *     Copy the Web app URL (ends in /exec) into lib/main.dart (kApiUrl).
 *  5. After changing this script later: run setupSheets again (adds any new
 *     tabs/columns), then Deploy > Manage deployments > pencil > New version.
 *
 * ORDER FLOW
 *   Pending -> Approved (manager) -> Cooking -> Ready (kitchen)
 *           -> Assigned (manager picks waiter / delivery man) -> Completed
 *   Side exits: Rejected (manager, from Pending), Cancelled, Failed (delivery).
 */

var SESSION_SECONDS = 21600; // 6 hours (maximum for the cache)
var TIMEZONE = 'Africa/Kampala';
var MAX_LOGIN_FAILS = 5;
var LOCKOUT_SECONDS = 600;
var HASH_ROUNDS = 1000;
var IMAGE_FOLDER = 'Kanyatsi Menu Images';
var MAX_IMAGE_BYTES = 1500000;

var SHEETS = {
  Menu: ['id', 'name', 'category', 'price', 'description', 'available', 'imageUrl'],
  Combos: ['id', 'name', 'description', 'price', 'available', 'imageUrl', 'itemsJson'],
  Stations: ['id', 'name', 'fee'],
  Settings: ['key', 'value'],
  Orders: ['id', 'createdAt', 'mode', 'table', 'stationId', 'stationName', 'customer',
           'phone', 'note', 'status', 'rejectReason', 'paymentMethod', 'paymentStatus',
           'subtotal', 'deliveryFee', 'total', 'channel', 'approvedBy', 'approvedAt',
           'cookedBy', 'readyAt', 'assignedToId', 'assignedToName', 'completedBy',
           'completedAt', 'updatedAt',
           'code', 'codeUsed', 'codeUsedAt', 'deliveryNote', 'amountCollected', 'paymentProvider', 'transactionId', 'paymentProofUrl', 'cashPresentedBy', 'servedAt', 'receiptCode', 'cashCode', 'cashHandoverStatus', 'managerCashConfirmedAt'],
  OrderItems: ['orderId', 'kind', 'itemId', 'name', 'qty', 'unitPrice', 'lineTotal', 'servings'],
  Inventory: ['id', 'name', 'unit', 'stock', 'minimum', 'packName', 'packSize', 'packPrice',
              'unitPrice', 'fullLevel', 'lowPct', 'updatedAt'],
  StockMovements: ['timestamp', 'itemId', 'name', 'change', 'reason', 'by', 'kind', 'unit', 'cost', 'balance'],
  Notifications: ['id', 'timestamp', 'roles', 'userId', 'title', 'body', 'orderId', 'kind'],
  Users: ['id', 'name', 'username', 'email', 'role', 'salt', 'passHash', 'active', 'mustChange'],
  Customers: ['phone', 'name', 'whatsappOptIn', 'optInDate'],
  FeatureRecords: ['id', 'type', 'title', 'details', 'amount', 'quantity', 'status', 'ownerId', 'ownerName', 'relatedId', 'code', 'payload', 'createdAt', 'updatedAt'],
  CustomerAccounts: ['id', 'phone', 'name', 'salt', 'passHash', 'pictureUrl', 'walletBalance', 'tokens', 'createdAt', 'active'],
  TableCodes: ['tableNo', 'code', 'active', 'updatedAt'],
  Workday: ['dateUserId', 'date', 'userId', 'name', 'role', 'available', 'tasksCompleted', 'tasksAssigned', 'updatedAt'],
  Audit: ['timestamp', 'user', 'role', 'action', 'details']
};

// Columns kept as text (phone numbers keep their leading 0, hashes never become numbers).
var TEXT_COLUMNS = {
  Orders: ['createdAt', 'phone', 'approvedAt', 'readyAt', 'completedAt', 'updatedAt', 'code', 'codeUsedAt', 'transactionId', 'paymentProofUrl', 'servedAt', 'receiptCode', 'cashCode'],
  StockMovements: ['timestamp'],
  Notifications: ['timestamp'],
  Inventory: ['updatedAt'],
  Users: ['username', 'email', 'salt', 'passHash'],
  Customers: ['phone', 'optInDate'],
  CustomerAccounts: ['phone', 'salt', 'passHash', 'pictureUrl', 'createdAt'],
  TableCodes: ['code', 'updatedAt'],
  Workday: ['date', 'updatedAt'],
  FeatureRecords: ['createdAt', 'updatedAt', 'code'],
  Audit: ['timestamp']
};

var ROLES = ['admin', 'manager', 'kitchen', 'waiter', 'delivery'];
var MODES = ['Indoor', 'Takeaway', 'Delivery'];
var CUSTOMER_PAYMENTS = {
  Indoor: ['Cash', 'Mobile Money', 'Wallet'],
  Takeaway: ['Cash', 'Mobile Money', 'Wallet'],
  Delivery: ['Mobile Money', 'Pay on Delivery', 'Wallet']
};
var MANAGER_PAYMENTS = ['Cash', 'Mobile Money', 'Pay on Delivery'];
var OPEN_STATUSES = ['Pending', 'Approved', 'Cooking', 'Ready', 'Assigned'];

// ---------------------------------------------------------------- entry points

function doGet() {
  return json_({ ok: true, message: 'Kanyatsi Restaurant API is running.' });
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    var req = JSON.parse(e.postData.contents);
    var handler = HANDLERS[String(req.action || '')];
    if (!handler) throw new Error('Unknown action');

    var user = null;
    if (handler.roles !== 'public') {
      user = sessionUser_(req.token);
      if (!user) throw new Error('SESSION_EXPIRED');
      if (handler.roles !== 'any' && handler.roles.indexOf(user.role) < 0) {
        throw new Error('FORBIDDEN');
      }
    }
    lock.waitLock(20000);
    return json_({ ok: true, data: handler.run(req, user) });
  } catch (err) {
    return json_({ ok: false, error: String(err.message || err) });
  } finally {
    try { lock.releaseLock(); } catch (x) {}
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
      .setMimeType(ContentService.MimeType.JSON);
}

var MGR = ['admin', 'manager'];

var HANDLERS = {
  // ----- public (customers)
  login:         { roles: 'public', run: login_ },
  requestReset:  { roles: 'public', run: requestReset_ },
  resetPassword: { roles: 'public', run: resetPassword_ },
  getMenu:       { roles: 'public', run: getMenu_ },
  createOrder:   { roles: 'public', run: createOrder_ },
  trackOrder:    { roles: 'public', run: trackOrder_ },
  cancelMyOrder: { roles: 'public', run: cancelMyOrder_ },
  customerRegister: { roles: 'public', run: customerRegister_ },
  customerLogin: { roles: 'public', run: customerLogin_ },
  customerProfile: { roles: 'public', run: customerProfile_ },
  customerHistory: { roles: 'public', run: customerHistory_ },
  customerReceiveFood: { roles: 'public', run: customerReceiveFood_ },
  serveOrder: { roles: ['waiter','admin','manager'], run: serveOrder_ },
  validateTableCode: { roles: 'public', run: validateTableCode_ },
  listPublicFeatures: { roles: 'public', run: listPublicFeatures_ },
  customerFeatureSave: { roles: 'public', run: customerFeatureSave_ },
  customerFeatureList: { roles: 'public', run: customerFeatureList_ },
  waiterCashCollected: { roles: ['waiter'], run: waiterCashCollected_ },
  confirmCashHandover: { roles: MGR, run: confirmCashHandover_ },
  uploadPaymentProof: { roles: 'public', run: uploadPaymentProof_ },

  // ----- any signed-in staff
  logout:         { roles: 'any', run: logout_ },
  listNotifications: { roles: 'any', run: listNotifications_ },
  changePassword: { roles: 'any', run: changePassword_ },

  // ----- manager / admin: orders
  listOrders:     { roles: MGR, run: listOrders_ },
  listCompleted:  { roles: MGR, run: listCompleted_ },
  approveOrder:   { roles: MGR, run: approveOrder_ },
  rejectOrder:    { roles: MGR, run: rejectOrder_ },
  allocateOrder:  { roles: MGR, run: allocateOrder_ },
  cancelOrder:    { roles: MGR, run: cancelOrder_ },
  markPaid:       { roles: MGR, run: markPaid_ },
  recordOrder:    { roles: MGR, run: recordOrder_ },
  listStaff:      { roles: MGR, run: listStaff_ },
  featureList:    { roles: ['admin','manager','kitchen','waiter','delivery'], run: featureList_ },
  staffCheckOrder: { roles: ['admin','manager','waiter'], run: staffCheckOrder_ },
  featureSave:    { roles: ['admin','manager','kitchen','waiter'], run: featureSave_ },
  featureAction:  { roles: ['admin','manager','waiter','delivery','kitchen'], run: featureAction_ },
  configureTableCodes: { roles: MGR, run: configureTableCodes_ },
  setWorkday:     { roles: MGR, run: setWorkday_ },
  listWorkday:    { roles: MGR, run: listWorkday_ },
  monthlyExportData: { roles: MGR, run: monthlyExportData_ },
  exportMonthlyReports: { roles: MGR, run: exportMonthlyReports_ },

  // ----- manager / admin: menu, combos, stations, tables
  saveDish:         { roles: MGR, run: saveDish_ },
  deleteDish:       { roles: MGR, run: deleteDish_ },
  setAvailability:  { roles: MGR, run: setAvailability_ },
  saveCombo:        { roles: MGR, run: saveCombo_ },
  deleteCombo:      { roles: MGR, run: deleteCombo_ },
  setComboAvailability: { roles: MGR, run: setComboAvailability_ },
  uploadImage:      { roles: MGR, run: uploadImage_ },
  saveStation:      { roles: MGR, run: saveStation_ },
  deleteStation:    { roles: MGR, run: deleteStation_ },
  saveTableCount:   { roles: MGR, run: saveTableCount_ },

  // ----- manager / admin: inventory, statistics, promotions
  listInventory:     { roles: ['admin', 'manager', 'kitchen'], run: listInventory_ },
  adjustStock:       { roles: MGR, run: adjustStock_ },
  saveInventoryItem: { roles: MGR, run: saveInventoryItem_ },
  deleteInventoryItem: { roles: MGR, run: deleteInventoryItem_ },
  addStock:          { roles: MGR, run: addStock_ },
  useStock:          { roles: ['kitchen', 'admin', 'manager'], run: useStock_ },
  stockReport:       { roles: MGR, run: stockReport_ },
  listStockMovements: { roles: MGR, run: listStockMovements_ },
  saveHeroImages:    { roles: MGR, run: saveHeroImages_ },
  sendNotification:  { roles: MGR, run: sendNotification_ },
  stats:             { roles: MGR, run: stats_ },
  listSubscribers:   { roles: MGR, run: listSubscribers_ },

  // ----- kitchen
  listKitchen:  { roles: ['kitchen', 'admin', 'manager'], run: listKitchen_ },
  startCooking: { roles: ['kitchen', 'admin', 'manager'], run: startCooking_ },
  markReady:    { roles: ['kitchen', 'admin', 'manager'], run: markReady_ },

  // ----- waiter / delivery man
  listMine:      { roles: ['waiter', 'delivery'], run: listMine_ },
  listMyDone:    { roles: ['waiter', 'delivery'], run: listMyDone_ },
  lookupDeliveryCode: { roles: ['delivery'], run: lookupDeliveryCode_ },
  confirmDelivery:    { roles: ['delivery'], run: confirmDelivery_ },
  completeOrder: { roles: ['waiter', 'delivery', 'admin', 'manager'], run: completeOrder_ },
  failOrder:     { roles: ['delivery', 'admin', 'manager'], run: failOrder_ },

  // ----- admin only
  listUsers:         { roles: ['admin'], run: listUsers_ },
  saveUser:          { roles: ['admin'], run: saveUser_ },
  updateUser:        { roles: ['admin'], run: updateUser_ },
  setUserActive:     { roles: ['admin'], run: setUserActive_ },
  resetUserPassword: { roles: ['admin'], run: resetUserPassword_ },
  deleteUser:        { roles: ['admin'], run: deleteUser_ },
  listAudit:         { roles: ['admin'], run: listAudit_ }
};

// ------------------------------------------------------------------------ auth

function sha256hex_(str) {
  var bytes = Utilities.computeDigest(
      Utilities.DigestAlgorithm.SHA_256, str, Utilities.Charset.UTF_8);
  return bytes.map(function (b) {
    return ('0' + (b < 0 ? b + 256 : b).toString(16)).slice(-2);
  }).join('');
}

function hashPassword_(salt, password) {
  var h = String(salt) + ':' + String(password);
  for (var i = 0; i < HASH_ROUNDS; i++) h = sha256hex_(h + salt);
  return h;
}

function validatePassword_(pw) {
  pw = String(pw || '');
  if (pw.length < 6 || pw.length > 64) throw new Error('Password must be 6 to 64 characters');
}

function login_(req) {
  var username = String(req.username || '').trim().toLowerCase();
  var password = String(req.password || '');
  if (!username || !password) throw new Error('Enter your username and password');

  var cache = CacheService.getScriptCache();
  var failKey = 'fails_' + username;
  var fails = Number(cache.get(failKey) || 0);
  if (fails >= MAX_LOGIN_FAILS) {
    throw new Error('Too many wrong attempts. Try again in 10 minutes.');
  }
  var found = findUserByUsername_(username);
  var ok = found && toBool_(found.active) &&
           hashPassword_(found.salt, password) === String(found.passHash);
  if (!ok) {
    cache.put(failKey, String(fails + 1), LOCKOUT_SECONDS);
    throw new Error('Wrong username or password');
  }
  cache.remove(failKey);

  var token = Utilities.getUuid() + Utilities.getUuid();
  var session = { id: Number(found.id), name: String(found.name),
                  username: String(found.username), role: String(found.role) };
  cache.put('t_' + token, JSON.stringify(session), SESSION_SECONDS);
  audit_(session, 'Login', '');
  return { token: token, role: session.role, name: session.name,
           mustChange: toBool_(found.mustChange) };
}

function logout_(req, user) {
  CacheService.getScriptCache().remove('t_' + req.token);
  audit_(user, 'Logout', '');
  return true;
}

function sessionUser_(token) {
  if (!token) return null;
  var raw = CacheService.getScriptCache().get('t_' + String(token));
  if (!raw) return null;
  var s = JSON.parse(raw);
  // Re-check the account every time, so disabling a user takes effect at once.
  var u = findRow_('Users', 'id', s.id);
  if (!u || !toBool_(u.active)) return null;
  s.role = String(u.role);
  s.name = String(u.name);
  return s;
}

function findUserByUsername_(username) {
  var users = readTable_('Users');
  for (var i = 0; i < users.length; i++) {
    if (String(users[i].username).toLowerCase() === username) return users[i];
  }
  return null;
}

function changePassword_(req, user) {
  validatePassword_(req.newPassword);
  var u = findRow_('Users', 'id', user.id);
  if (!u) throw new Error('User not found');
  if (hashPassword_(u.salt, req.oldPassword) !== String(u.passHash)) {
    throw new Error('Current password is wrong');
  }
  if (String(req.newPassword) === String(req.oldPassword)) {
    throw new Error('Choose a different password');
  }
  setPassword_(user.id, req.newPassword, false);
  audit_(user, 'Password changed', '');
  return true;
}

function setPassword_(userId, password, mustChange) {
  var salt = Utilities.getUuid();
  updateRow_('Users', 'id', userId, {
    salt: salt, passHash: hashPassword_(salt, password), mustChange: !!mustChange
  });
}

// Forgot password: a 6-digit code is emailed to the address the admin saved.
function requestReset_(req) {
  var username = String(req.username || '').trim().toLowerCase();
  var generic = { message: 'If this username has an email address saved, a code has been sent. ' +
                           'Otherwise ask the administrator to reset your password.' };
  if (!username) throw new Error('Enter your username');
  var cache = CacheService.getScriptCache();
  var rlKey = 'resetreq_' + username;
  var count = Number(cache.get(rlKey) || 0);
  if (count >= 3) throw new Error('Too many requests. Try again in an hour.');
  cache.put(rlKey, String(count + 1), 3600);

  var u = findUserByUsername_(username);
  if (u && toBool_(u.active) && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(u.email))) {
    var code = String(Math.floor(100000 + Math.random() * 900000));
    cache.put('reset_' + username,
              JSON.stringify({ h: sha256hex_(code + ':' + u.salt), tries: 0 }), 900);
    MailApp.sendEmail(String(u.email), 'Kanyatsi Restaurant - password reset code',
        'Hello ' + u.name + ',\n\nYour password reset code is ' + code +
        '.\nIt works for 15 minutes. If you did not ask for it, ignore this email.');
    audit_({ name: String(u.name), role: String(u.role) }, 'Password reset requested', '');
  }
  return generic;
}

function resetPassword_(req) {
  var username = String(req.username || '').trim().toLowerCase();
  validatePassword_(req.newPassword);
  var cache = CacheService.getScriptCache();
  var raw = cache.get('reset_' + username);
  var u = findUserByUsername_(username);
  if (!raw || !u) throw new Error('The code is wrong or has expired');
  var rec = JSON.parse(raw);
  if (rec.tries >= 5) { cache.remove('reset_' + username); throw new Error('Too many attempts. Request a new code.'); }
  if (sha256hex_(String(req.code || '').trim() + ':' + u.salt) !== rec.h) {
    rec.tries++;
    cache.put('reset_' + username, JSON.stringify(rec), 900);
    throw new Error('The code is wrong or has expired');
  }
  cache.remove('reset_' + username);
  cache.remove('fails_' + username);
  setPassword_(u.id, req.newPassword, false);
  audit_({ name: String(u.name), role: String(u.role) }, 'Password reset by code', '');
  return true;
}

// ----------------------------------------------------------------- users (admin)

function publicUser_(u) {
  return { id: Number(u.id), name: String(u.name), username: String(u.username),
           email: String(u.email || ''), role: String(u.role), active: toBool_(u.active) };
}

function listUsers_() {
  return readTable_('Users').map(publicUser_);
}

function listStaff_() {
  return readTable_('Users').filter(function (u) { return toBool_(u.active); })
      .map(function (u) { return { id: Number(u.id), name: String(u.name), role: String(u.role) }; });
}

function validEmail_(email) {
  email = String(email || '').trim();
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Enter a valid email or leave it empty');
  return email;
}

function activeAdminCount_(exceptId) {
  return readTable_('Users').filter(function (u) {
    return u.role === 'admin' && toBool_(u.active) && String(u.id) !== String(exceptId);
  }).length;
}

function saveUser_(req, user) {
  var name = String(req.name || '').trim();
  var username = String(req.username || '').trim().toLowerCase();
  var role = String(req.role || '');
  var email = validEmail_(req.email);
  if (!name || !/^[a-z0-9._-]{3,30}$/.test(username)) {
    throw new Error('Name is required; username needs 3-30 letters/numbers');
  }
  if (ROLES.indexOf(role) < 0) throw new Error('Choose a role');
  validatePassword_(req.password);
  if (findUserByUsername_(username)) throw new Error('That username is already taken');
  var id = nextId_('Users', 'id', 1);
  var salt = Utilities.getUuid();
  appendRow_('Users', { id: id, name: name, username: username, email: email, role: role,
                        salt: salt, passHash: hashPassword_(salt, req.password),
                        active: true, mustChange: true });
  audit_(user, 'User created', username + ' (' + role + ')');
  return { id: id };
}

function updateUser_(req, user) {
  var u = findRow_('Users', 'id', req.id);
  if (!u) throw new Error('User not found');
  var name = String(req.name || '').trim();
  var role = String(req.role || '');
  if (!name) throw new Error('Name is required');
  if (ROLES.indexOf(role) < 0) throw new Error('Choose a role');
  if (u.role === 'admin' && role !== 'admin' && activeAdminCount_(u.id) === 0) {
    throw new Error('There must be at least one active administrator');
  }
  updateRow_('Users', 'id', req.id, { name: name, email: validEmail_(req.email), role: role });
  audit_(user, 'User edited', u.username + ' -> ' + role);
  return true;
}

function setUserActive_(req, user) {
  var u = findRow_('Users', 'id', req.id);
  if (!u) throw new Error('User not found');
  if (!req.active && u.role === 'admin' && activeAdminCount_(u.id) === 0) {
    throw new Error('There must be at least one active administrator');
  }
  if (String(u.id) === String(user.id) && !req.active) {
    throw new Error('You cannot disable your own account');
  }
  updateRow_('Users', 'id', req.id, { active: !!req.active });
  audit_(user, req.active ? 'User enabled' : 'User disabled', u.username);
  return true;
}

function resetUserPassword_(req, user) {
  var u = findRow_('Users', 'id', req.id);
  if (!u) throw new Error('User not found');
  validatePassword_(req.password);
  setPassword_(u.id, req.password, true);
  CacheService.getScriptCache().remove('fails_' + String(u.username).toLowerCase());
  audit_(user, 'Password reset by admin', u.username);
  return true;
}

function deleteUser_(req, user) {
  var u = findRow_('Users', 'id', req.id);
  if (!u) throw new Error('User not found');
  if (String(u.id) === String(user.id)) throw new Error('You cannot delete your own account');
  if (u.role === 'admin' && toBool_(u.active) && activeAdminCount_(u.id) === 0) {
    throw new Error('There must be at least one active administrator');
  }
  deleteRow_('Users', 'id', req.id);
  audit_(user, 'User deleted', u.username);
  return true;
}

function listAudit_() {
  var rows = readTable_('Audit').map(function (a) {
    return { timestamp: String(a.timestamp), user: String(a.user), role: String(a.role),
             action: String(a.action), details: String(a.details) };
  });
  return rows.reverse().slice(0, 150);
}

// ------------------------------------------------------------ menu / combos / info

function dishView_(m) {
  return { id: Number(m.id), name: String(m.name), category: String(m.category),
           price: Number(m.price), description: String(m.description || ''),
           available: toBool_(m.available), imageUrl: String(m.imageUrl || '') };
}

function parseItems_(json) {
  try {
    var arr = JSON.parse(String(json || '[]'));
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}

function getMenu_() {
  var dishes = readTable_('Menu');
  var byId = {};
  dishes.forEach(function (d) { byId[String(d.id)] = d; });

  var combos = readTable_('Combos').map(function (c) {
    var items = parseItems_(c.itemsJson).map(function (it) {
      var d = byId[String(it.id)];
      return { id: Number(it.id), name: d ? String(d.name) : '(removed dish)', qty: Number(it.qty) };
    });
    var allThere = items.length > 0 && items.every(function (it) {
      var d = byId[String(it.id)];
      return d && toBool_(d.available);
    });
    var itemsTotal = 0;
    items.forEach(function (it) {
      var d = byId[String(it.id)];
      if (d) itemsTotal += Number(d.price) * it.qty;
    });
    return { id: Number(c.id), name: String(c.name), description: String(c.description || ''),
             price: Number(c.price), available: toBool_(c.available) && allThere,
             enabled: toBool_(c.available), imageUrl: String(c.imageUrl || ''),
             items: items, itemsTotal: itemsTotal };
  });

  var stations = readTable_('Stations').map(function (s) {
    return { id: Number(s.id), name: String(s.name), fee: Number(s.fee) };
  });
  return { dishes: dishes.map(dishView_), combos: combos, stations: stations,
           tableCount: Number(getSetting_('tableCount', 10)),
           heroImages: parseItems_(getSetting_('heroImages', '[]')) };
}

function saveDish_(req, user) {
  var it = req.item || {};
  var name = String(it.name || '').trim();
  var category = String(it.category || '').trim();
  var price = Number(it.price);
  if (!name || !category) throw new Error('Name and category are required');
  if (!(price >= 0)) throw new Error('Enter a valid price');
  var row = { name: name, category: category, price: price,
              description: String(it.description || '').trim(),
              available: it.available === false ? false : true,
              imageUrl: String(it.imageUrl || '') };
  if (it.id) {
    var old = findRow_('Menu', 'id', it.id);
    if (!old) throw new Error('Dish not found');
    updateRow_('Menu', 'id', it.id, row);
    audit_(user, Number(old.price) !== price ? 'Price change' : 'Dish edited',
           Number(old.price) !== price ? name + ': ' + old.price + ' -> ' + price : name);
    return { id: Number(it.id) };
  }
  row.id = nextId_('Menu', 'id', 1);
  appendRow_('Menu', row);
  audit_(user, 'Dish added', name + ' @ ' + price);
  return { id: row.id };
}

function deleteDish_(req, user) {
  var d = findRow_('Menu', 'id', req.id);
  if (!d) throw new Error('Dish not found');
  var inCombo = readTable_('Combos').filter(function (c) {
    return parseItems_(c.itemsJson).some(function (it) { return String(it.id) === String(req.id); });
  });
  if (inCombo.length) throw new Error('This dish is part of the combo "' + inCombo[0].name + '". Edit the combo first.');
  deleteRow_('Menu', 'id', req.id);
  audit_(user, 'Dish deleted', String(d.name));
  return true;
}

function setAvailability_(req, user) {
  var d = findRow_('Menu', 'id', req.id);
  if (!d) throw new Error('Dish not found');
  updateRow_('Menu', 'id', req.id, { available: !!req.available });
  audit_(user, 'Availability', d.name + ' -> ' + (req.available ? 'available' : 'unavailable'));
  return true;
}

function saveCombo_(req, user) {
  var c = req.item || {};
  var name = String(c.name || '').trim();
  var price = Number(c.price);
  if (!name) throw new Error('Name is required');
  if (!(price >= 0)) throw new Error('Enter a valid price');
  var items = Array.isArray(c.items) ? c.items : [];
  var clean = [];
  items.forEach(function (it) {
    var qty = Math.floor(Number(it.qty));
    if (qty >= 1) {
      if (!findRow_('Menu', 'id', it.id)) throw new Error('A selected dish no longer exists');
      clean.push({ id: Number(it.id), qty: qty });
    }
  });
  if (clean.length < 2 && !(clean.length === 1 && clean[0].qty >= 2)) {
    throw new Error('A combo needs at least two servings of food');
  }
  var row = { name: name, description: String(c.description || '').trim(), price: price,
              available: c.available === false ? false : true,
              imageUrl: String(c.imageUrl || ''), itemsJson: JSON.stringify(clean) };
  if (c.id) {
    if (!findRow_('Combos', 'id', c.id)) throw new Error('Combo not found');
    updateRow_('Combos', 'id', c.id, row);
    audit_(user, 'Combo edited', name + ' @ ' + price);
    return { id: Number(c.id) };
  }
  row.id = nextId_('Combos', 'id', 1);
  appendRow_('Combos', row);
  audit_(user, 'Combo added', name + ' @ ' + price);
  return { id: row.id };
}

function deleteCombo_(req, user) {
  var c = findRow_('Combos', 'id', req.id);
  if (!c) throw new Error('Combo not found');
  deleteRow_('Combos', 'id', req.id);
  audit_(user, 'Combo deleted', String(c.name));
  return true;
}

function setComboAvailability_(req, user) {
  var c = findRow_('Combos', 'id', req.id);
  if (!c) throw new Error('Combo not found');
  updateRow_('Combos', 'id', req.id, { available: !!req.available });
  audit_(user, 'Combo availability', c.name + ' -> ' + (req.available ? 'available' : 'unavailable'));
  return true;
}

// Food pictures are stored in Google Drive; only the link is kept in the sheet.
function uploadImage_(req, user) {
  var mime = String(req.mime || 'image/jpeg');
  if (['image/jpeg', 'image/png'].indexOf(mime) < 0) throw new Error('Use a JPG or PNG picture');
  var bytes = Utilities.base64Decode(String(req.data || ''));
  if (!bytes.length) throw new Error('No picture received');
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error('Picture is too large. Choose a smaller one.');
  var folders = DriveApp.getFoldersByName(IMAGE_FOLDER);
  var folder = folders.hasNext() ? folders.next() : DriveApp.createFolder(IMAGE_FOLDER);
  var ext = mime === 'image/png' ? '.png' : '.jpg';
  var file = folder.createFile(Utilities.newBlob(bytes, mime, 'food_' + new Date().getTime() + ext));
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  audit_(user, 'Picture uploaded', '');
  var width = Math.max(400, Math.min(1600, Math.floor(Number(req.size || 800))));
  return { url: 'https://drive.google.com/thumbnail?id=' + file.getId() + '&sz=w' + width };
}

function uploadPaymentProof_(req){
  var mime=String(req.mime||'image/jpeg'); if(['image/jpeg','image/png'].indexOf(mime)<0)throw new Error('Upload a JPG or PNG screenshot.'); var bytes=Utilities.base64Decode(String(req.data||'')); if(!bytes.length||bytes.length>MAX_IMAGE_BYTES)throw new Error('Screenshot is empty or too large (maximum 1.5 MB).'); var folders=DriveApp.getFoldersByName(IMAGE_FOLDER);var folder=folders.hasNext()?folders.next():DriveApp.createFolder(IMAGE_FOLDER);var ext=mime==='image/png'?'.png':'.jpg';var file=folder.createFile(Utilities.newBlob(bytes,mime,'payment_proof_'+new Date().getTime()+ext));file.setSharing(DriveApp.Access.ANYONE_WITH_LINK,DriveApp.Permission.VIEW);return {url:'https://drive.google.com/thumbnail?id='+file.getId()+'&sz=w1200'};
}

function saveStation_(req, user) {
  var name = String(req.name || '').trim();
  var fee = Number(req.fee);
  if (!name) throw new Error('Station name is required');
  if (!(fee >= 0)) throw new Error('Enter a valid delivery fee');
  var dup = readTable_('Stations').filter(function (s) {
    return String(s.name).toLowerCase() === name.toLowerCase() && String(s.id) !== String(req.id || '');
  });
  if (dup.length) throw new Error('A station with that name already exists');
  if (req.id) {
    var old = findRow_('Stations', 'id', req.id);
    if (!old) throw new Error('Station not found');
    updateRow_('Stations', 'id', req.id, { name: name, fee: fee });
    audit_(user, 'Station edited', name + ' fee ' + old.fee + ' -> ' + fee);
    return { id: Number(req.id) };
  }
  var id = nextId_('Stations', 'id', 1);
  appendRow_('Stations', { id: id, name: name, fee: fee });
  audit_(user, 'Station added', name + ' fee ' + fee);
  return { id: id };
}

function deleteStation_(req, user) {
  var s = findRow_('Stations', 'id', req.id);
  if (!s) throw new Error('Station not found');
  deleteRow_('Stations', 'id', req.id);
  audit_(user, 'Station removed', String(s.name));
  return true;
}

function saveTableCount_(req, user) {
  var n = Math.floor(Number(req.tableCount));
  if (!(n >= 1 && n <= 200)) throw new Error('Tables must be between 1 and 200');
  setSetting_('tableCount', n);
  audit_(user, 'Table count', String(n));
  return { tableCount: n };
}

// -------------------------------------------------------------------- orders

function cleanPhone_(p) { return String(p || '').replace(/[^0-9]/g, ''); }
function last9_(p) { return cleanPhone_(p).slice(-9); }

// Builds and stores an order. Used by customers (createOrder) and the manager (recordOrder).
function buildOrder_(req, opts) {
  var items = req.items;
  if (!Array.isArray(items) || items.length === 0) throw new Error('Nothing selected');
  if (items.length > 60) throw new Error('Too many items');

  var mode = String(req.mode || '');
  if (MODES.indexOf(mode) < 0) throw new Error('Choose Indoor, Takeaway or Delivery');
  var payment = String(req.payment || '');
  var allowed = opts.staff ? MANAGER_PAYMENTS : CUSTOMER_PAYMENTS[mode];
  if (allowed.indexOf(payment) < 0) throw new Error('Choose how you will pay');
  if (payment === 'Mobile Money' && !String(req.transactionId||'').trim() && !String(req.paymentProofUrl||'').trim()) throw new Error('For Mobile Money, enter a transaction ID or upload a screenshot of the payment.');

  var name = String(req.customer || '').trim().slice(0, 60);
  var phone = cleanPhone_(req.phone);
  var note = String(req.note || '').trim().slice(0, 200);
  var phoneNeeded = !opts.staff || mode === 'Delivery';
  if (phoneNeeded && phone.length < 9) throw new Error('Enter a valid phone number');
  if (!opts.staff && mode !== 'Indoor' && !name) throw new Error('Enter your name');

  var table = '', stationId = '', stationName = '', fee = 0;
  if (mode === 'Indoor') {
    table = Math.floor(Number(req.table));
    var count = Number(getSetting_('tableCount', 10));
    if (!(table >= 1 && table <= count)) throw new Error('Choose your table number');
    if (!opts.staff && String(getSetting_('requireTableCode','false')) === 'true') { var tc=readTable_('TableCodes').filter(function(x){return Number(x.tableNo)===table && toBool_(x.active);})[0]; if(!tc || String(req.tableCode||'')!==String(tc.code)) throw new Error('Invalid table code for this table.'); }
  } else if (mode === 'Delivery') {
    var st = findRow_('Stations', 'id', req.stationId);
    if (!st) throw new Error('Choose a delivery pick-up station');
    stationId = Number(st.id); stationName = String(st.name); fee = Number(st.fee);
  }

  if (!opts.staff && phone) {
    var pending = readTable_('Orders').filter(function (o) {
      return o.status === 'Pending' && last9_(o.phone) === last9_(phone);
    }).length;
    if (pending >= 3) throw new Error('You already have orders waiting for confirmation. Please wait for our call.');
  }

  // Prices ALWAYS come from the sheet, never from the app.
  var menu = getMenu_();
  var dishes = {}, combos = {};
  menu.dishes.forEach(function (d) { dishes[String(d.id)] = d; });
  menu.combos.forEach(function (c) { combos[String(c.id)] = c; });

  var lines = [], subtotal = 0;
  items.forEach(function (x) {
    var qty = Math.floor(Number(x.qty));
    if (!(qty >= 1 && qty <= 50)) throw new Error('Invalid quantity');
    if (x.kind === 'combo') {
      var c = combos[String(x.id)];
      if (!c) throw new Error('A combo on your order no longer exists');
      if (!c.available) throw new Error(c.name + ' is not available right now');
      var per = c.items.reduce(function (s, it) { return s + it.qty; }, 0);
      lines.push({ kind: 'combo', itemId: c.id, name: c.name, qty: qty, unitPrice: c.price,
                   lineTotal: c.price * qty, servings: per * qty });
      subtotal += c.price * qty;
    } else {
      var d = dishes[String(x.id)];
      if (!d) throw new Error('A dish on your order no longer exists');
      if (!d.available) throw new Error(d.name + ' is not available right now');
      lines.push({ kind: 'dish', itemId: d.id, name: d.name, qty: qty, unitPrice: d.price,
                   lineTotal: d.price * qty, servings: qty });
      subtotal += d.price * qty;
    }
  });

  var total = subtotal + fee;
  var walletAccount = null;
  if (!opts.staff && payment === 'Wallet') { walletAccount = authenticateCustomer_({phone:phone,password:String(req.customerPassword||'')}); if(num_(walletAccount.walletBalance)<total) throw new Error('Insufficient wallet balance. Add funds or choose another payment method.'); updateRow_('CustomerAccounts','phone',walletAccount.phone,{walletBalance:num_(walletAccount.walletBalance)-total}); }
  var orderId = nextId_('Orders', 'id', 1001);
  var now = now_();
  var order = {
    id: orderId, createdAt: now, mode: mode, table: table, stationId: stationId,
    stationName: stationName, customer: name || (opts.staff ? 'Walk-in Customer' : 'Guest'),
    phone: phone, note: note, status: opts.staff ? 'Approved' : 'Pending',
    rejectReason: '', paymentMethod: payment,
    paymentStatus: (opts.staff && req.paid) || payment === 'Wallet' ? 'Paid' : 'Unpaid',
    subtotal: subtotal, deliveryFee: fee, total: total,
    channel: opts.staff ? 'Manager' : 'App',
    approvedBy: opts.staff ? opts.user.name : '', approvedAt: opts.staff ? now : '',
    cookedBy: '', readyAt: '', assignedToId: '', assignedToName: '',
    completedBy: '', completedAt: '', updatedAt: now,
    code: mode === 'Delivery' ? newDeliveryCode_() : '', codeUsed: false, codeUsedAt: '',
    deliveryNote: '', amountCollected: '', cashCode: (mode==='Indoor' && payment==='Cash' ? Utilities.getUuid().replace(/-/g,'').substring(0,8).toUpperCase() : ''), cashHandoverStatus: 'Not collected', managerCashConfirmedAt: '', paymentProvider: String(req.paymentProvider||''), transactionId: String(req.transactionId||''), paymentProofUrl: String(req.paymentProofUrl||''), cashPresentedBy: '', servedAt: '', receiptCode: ''
  };
  appendRow_('Orders', order);
  lines.forEach(function (l) {
    appendRow_('OrderItems', { orderId: orderId, kind: l.kind, itemId: l.itemId, name: l.name,
      qty: l.qty, unitPrice: l.unitPrice, lineTotal: l.lineTotal, servings: l.servings });
  });
  if (phone.length >= 9) saveCustomer_(phone, name, !opts.staff && !!req.whatsappOptIn);
  audit_(opts.user || { name: 'Customer', role: 'customer' },
         opts.staff ? 'Order recorded' : 'Order placed', '#' + orderId + ' UGX ' + total);
  if (opts.staff) {
    notify_(['kitchen'], '', 'New order to cook', '#' + orderId + ' - ' + mode, orderId, 'order');
  } else {
    notify_(['manager', 'admin'], '', 'New order #' + orderId,
            mode + ' - ' + (name || 'Guest') + ' - UGX ' + total, orderId, 'order');
  }
  return { orderId: orderId, total: total, deliveryFee: fee, code: String(order.code) };
}

function createOrder_(req) { return buildOrder_(req, { staff: false, user: null }); }

function recordOrder_(req, user) { return buildOrder_(req, { staff: true, user: user }); }

function orderView_(o, itemsByOrder, includeCode) {
  var lines = itemsByOrder[String(o.id)] || [];
  return {
    id: Number(o.id), createdAt: String(o.createdAt), mode: String(o.mode),
    table: o.table === '' ? 0 : Number(o.table), stationName: String(o.stationName || ''),
    customer: String(o.customer), phone: String(o.phone), note: String(o.note || ''),
    status: String(o.status), rejectReason: String(o.rejectReason || ''),
    payment: String(o.paymentMethod), paymentStatus: String(o.paymentStatus), paymentProvider: String(o.paymentProvider||''), transactionId: String(o.transactionId||''), paymentProofUrl: String(o.paymentProofUrl||''),
    subtotal: Number(o.subtotal), deliveryFee: Number(o.deliveryFee), total: Number(o.total),
    channel: String(o.channel), approvedBy: String(o.approvedBy || ''),
    assignedToId: o.assignedToId === '' ? 0 : Number(o.assignedToId),
    assignedToName: String(o.assignedToName || ''), completedBy: String(o.completedBy || ''),
    completedAt: String(o.completedAt || ''), servedAt: String(o.servedAt || ''), receiptCode: String(o.receiptCode || ''), lines: lines,
    code: includeCode ? String(o.code || '') : '', cashCode: includeCode ? String(o.cashCode||'') : '', cashHandoverStatus: String(o.cashHandoverStatus||''),
    hasCode: String(o.code || '') !== '',
    codeUsed: toBool_(o.codeUsed), codeUsedAt: String(o.codeUsedAt || ''),
    deliveryNote: String(o.deliveryNote || ''),
    amountCollected: o.amountCollected === '' ? 0 : Number(o.amountCollected)
  };
}

function itemsByOrder_() {
  var map = {};
  readTable_('OrderItems').forEach(function (x) {
    (map[String(x.orderId)] = map[String(x.orderId)] || []).push(x.qty + ' x ' + x.name);
  });
  return map;
}

function viewOrders_(filterFn, limit, newestFirst, includeCode) {
  var items = itemsByOrder_();
  var rows = readTable_('Orders').filter(filterFn).map(function (o) { return orderView_(o, items, !!includeCode); });
  rows.sort(function (a, b) { return newestFirst ? b.id - a.id : a.id - b.id; });
  return rows.slice(0, limit);
}

function listOrders_() { return viewOrders_(function () { return true; }, 300, true, true); }

function listCompleted_(req) {
  var days = Math.max(0, Math.floor(Number(req.days || 0)));
  var cutoff = days > 0 ? daysAgoStr_(days - 1) : '';
  return viewOrders_(function (o) {
    return o.status === 'Completed' && (!cutoff || String(o.completedAt).slice(0, 10) >= cutoff);
  }, 300, true, true);
}

function listKitchen_() {
  return viewOrders_(function (o) { return o.status === 'Approved' || o.status === 'Cooking'; }, 100, false);
}

function listMine_(req, user) {
  return viewOrders_(function (o) {
    return o.status === 'Assigned' && String(o.assignedToId) === String(user.id);
  }, 100, false, true);
}

function getOrder_(id) {
  var o = findRow_('Orders', 'id', id);
  if (!o) throw new Error('Order not found');
  return o;
}

function expect_(o, statuses, message) {
  if (statuses.indexOf(o.status) < 0) throw new Error(message || ('Order #' + o.id + ' is ' + o.status));
}

function setStatus_(o, changes) {
  changes.updatedAt = now_();
  updateRow_('Orders', 'id', o.id, changes);
}

function approveOrder_(req, user) {
  var o = getOrder_(req.id);
  expect_(o, ['Pending'], 'Only pending orders can be approved');
  if(o.paymentMethod==='Mobile Money' && (!String(o.transactionId||'').trim() && !String(o.paymentProofUrl||'').trim())) throw new Error('Mobile Money proof is missing. Ask customer for transaction ID or screenshot first.');
  setStatus_(o, { status: 'Approved', approvedBy: user.name, approvedAt: now_(), paymentStatus: o.paymentMethod==='Mobile Money' ? 'Paid' : o.paymentStatus });
  audit_(user, 'Order approved', '#' + o.id);
  notify_(['kitchen'], '', 'New order to cook', '#' + o.id + ' - ' + o.mode, o.id, 'order');
  return true;
}

function rejectOrder_(req, user) {
  var o = getOrder_(req.id);
  expect_(o, ['Pending'], 'Only pending orders can be rejected');
  var reason = String(req.reason || '').trim().slice(0, 150);
  if (!reason) throw new Error('Give a reason for the customer');
  setStatus_(o, { status: 'Rejected', rejectReason: reason });
  audit_(user, 'Order rejected', '#' + o.id + ': ' + reason);
  return true;
}

function startCooking_(req, user) {
  var o = getOrder_(req.id);
  expect_(o, ['Approved'], 'This order is not waiting for the kitchen');
  setStatus_(o, { status: 'Cooking', cookedBy: user.name });
  audit_(user, 'Cooking started', '#' + o.id);
  return true;
}

function markReady_(req, user) {
  var o = getOrder_(req.id);
  expect_(o, ['Cooking', 'Approved'], 'This order is not being cooked');
  setStatus_(o, { status: 'Ready', readyAt: now_(), cookedBy: o.cookedBy || user.name });
  audit_(user, 'Order ready', '#' + o.id);
  notify_(['manager', 'admin'], '', 'Order #' + o.id + ' is ready',
          'Give it to a ' + (o.mode === 'Delivery' ? 'delivery man' : 'waiter') + '.', o.id, 'order');
  return true;
}

function allocateOrder_(req, user) {
  var o = getOrder_(req.id);
  expect_(o, ['Ready', 'Assigned'], 'Only ready orders can be allocated');
  var needed = o.mode === 'Delivery' ? 'delivery' : 'waiter';
  var staff = req.staffId ? findRow_('Users', 'id', req.staffId) : null;
  if (!req.staffId) {
    var today=Utilities.formatDate(new Date(),TIMEZONE,'yyyy-MM-dd');
    var shifts=readTable_('Workday').filter(function(w){return String(w.date)===today && toBool_(w.available) && String(w.role)===needed;}).sort(function(a,b){return num_(a.tasksCompleted)-num_(b.tasksCompleted)||num_(a.tasksAssigned)-num_(b.tasksAssigned);});
    if(shifts.length) staff=findRow_('Users','id',shifts[0].userId);
  }
  if (!staff || !toBool_(staff.active)) throw new Error("Choose an active available staff member, or configure today's workday first.");
  if (staff.role !== needed) {
    throw new Error(o.mode === 'Delivery' ? 'Choose a delivery man' : 'Choose a waiter');
  }
  var note = String(req.note || '').trim().slice(0, 300);
  if (!note && o.mode === 'Delivery' && o.paymentStatus !== 'Paid' &&
      (o.paymentMethod === 'Pay on Delivery' || o.paymentMethod === 'Cash')) {
    note = 'Collect UGX ' + o.total + ' from the customer on delivery.';
  }
  setStatus_(o, { status: 'Assigned', assignedToId: Number(staff.id), assignedToName: String(staff.name),
                  deliveryNote: note });
  var todayShift=readTable_('Workday').filter(function(w){return String(w.date)===Utilities.formatDate(new Date(),TIMEZONE,'yyyy-MM-dd')&&String(w.userId)===String(staff.id);})[0]; if(todayShift) updateRow_('Workday','dateUserId',Utilities.formatDate(new Date(),TIMEZONE,'yyyy-MM-dd')+'_'+staff.id,{tasksAssigned:num_(todayShift.tasksAssigned)+1,available:false,updatedAt:now_()});
  audit_(user, 'Order allocated', '#' + o.id + ' -> ' + staff.name);
  notify_([], staff.id, 'Order #' + o.id + ' assigned to you',
          (o.mode === 'Delivery' ? 'Deliver to ' + o.stationName : 'Serve: ' + o.mode) +
          (note ? ' - ' + note : ''), o.id, 'assignment');
  return true;
}

function isAssignee_(o, user) {
  return String(o.assignedToId) === String(user.id);
}

function completeOrder_(req, user) {
  var o = getOrder_(req.id);
  expect_(o, ['Assigned'], 'This order has not been allocated yet');
  if(o.mode==='Indoor'&&o.paymentMethod==='Cash'&&String(o.cashHandoverStatus)!=='Cash received by manager') throw new Error('Waiter must present the cash and matching order code to the manager before completing this indoor cash order.');
  if(user.role==='waiter'&&o.mode!=='Delivery'&&(!String(o.servedAt||'')||!String(o.receiptCode||'')||String(req.code||'')!==String(o.receiptCode)))throw new Error('Mark food served, then enter the receipt code generated when the customer tapped Receive Food.');
  if (user.role !== 'admin' && user.role !== 'manager' && !isAssignee_(o, user)) {
    throw new Error('FORBIDDEN');
  }
  if (o.mode === 'Delivery' && String(o.code || '') !== '' && !toBool_(o.codeUsed) &&
      user.role === 'delivery') {
    throw new Error('Enter the customer\'s delivery code to complete this delivery.');
  }
  var done = { status: 'Completed', completedBy: user.name, completedAt: now_() };
  if (o.mode === 'Delivery' && String(o.code || '') !== '' && !toBool_(o.codeUsed)) {
    done.codeUsed = true; done.codeUsedAt = now_();   // manager override also closes the code
  }
  setStatus_(o, done);
  awardOrderTokens_(o);
  var shift=readTable_('Workday').filter(function(w){return String(w.date)===Utilities.formatDate(new Date(),TIMEZONE,'yyyy-MM-dd')&&String(w.userId)===String(o.assignedToId);})[0]; if(shift) updateRow_('Workday','dateUserId',Utilities.formatDate(new Date(),TIMEZONE,'yyyy-MM-dd')+'_'+o.assignedToId,{tasksCompleted:num_(shift.tasksCompleted)+1,available:true,updatedAt:now_()});
  audit_(user, 'Order completed', '#' + o.id);
  notify_(['manager', 'admin'], '', 'Order #' + o.id + ' completed', 'By ' + user.name, o.id, 'order');
  return true;
}

function failOrder_(req, user) {
  var o = getOrder_(req.id);
  expect_(o, ['Assigned'], 'This order is not out for delivery');
  if (o.mode !== 'Delivery') throw new Error('Only deliveries can fail');
  if (user.role !== 'admin' && user.role !== 'manager' && !isAssignee_(o, user)) {
    throw new Error('FORBIDDEN');
  }
  var reason = String(req.reason || '').trim().slice(0, 150);
  if (!reason) throw new Error('Give the reason the delivery failed');
  setStatus_(o, { status: 'Failed', rejectReason: reason, codeUsed: true, codeUsedAt: now_() });
  audit_(user, 'Delivery failed', '#' + o.id + ': ' + reason);
  notify_(['manager', 'admin'], '', 'Delivery failed #' + o.id, reason, o.id, 'alert');
  return true;
}

function cancelOrder_(req, user) {
  var o = getOrder_(req.id);
  expect_(o, OPEN_STATUSES, 'This order can no longer be cancelled');
  var reason = String(req.reason || '').trim().slice(0, 150);
  if (!reason) throw new Error('Give a reason');
  if(String(o.paymentMethod)==='Wallet' && String(o.paymentStatus)==='Paid'){var acct=readTable_('CustomerAccounts').filter(function(a){return String(a.phone)===String(o.phone);})[0];if(acct)updateRow_('CustomerAccounts','phone',o.phone,{walletBalance:num_(acct.walletBalance)+num_(o.total)});}
  setStatus_(o, { status: 'Cancelled', rejectReason: reason, codeUsed: true });
  audit_(user, 'Order cancelled', '#' + o.id + ': ' + reason);
  return true;
}

function markPaid_(req, user) {
  var o = getOrder_(req.id);
  if(o.mode==='Indoor'&&o.paymentMethod==='Cash'&&String(o.cashHandoverStatus)!=='Cash received by manager') throw new Error('Confirm cash handover with the matching order code first.');
  if (['Rejected', 'Cancelled', 'Failed'].indexOf(o.status) >= 0) throw new Error('This order was not completed');
  if (o.paymentMethod === 'Mobile Money' && !String(o.transactionId||req.transactionId||'').trim() && !String(o.paymentProofUrl||req.paymentProofUrl||'').trim()) throw new Error('Mobile Money must include a transaction ID or proof before it can be marked paid.');
  setStatus_(o, { paymentStatus: 'Paid', transactionId: String(req.transactionId||o.transactionId||''), paymentProofUrl: String(req.paymentProofUrl||o.paymentProofUrl||''), paymentProvider: String(req.paymentProvider||o.paymentProvider||'') });
  audit_(user, 'Payment recorded', '#' + o.id + ' UGX ' + o.total + ' via ' + o.paymentMethod);
  return true;
}

// Customer follow-up with order number + phone.
function findCustomerOrder_(req) {
  var o = findRow_('Orders', 'id', req.orderId);
  var phone = cleanPhone_(req.phone);
  if (!o || phone.length < 9 || last9_(o.phone) !== last9_(phone)) {
    throw new Error('Order not found. Check the order number and phone number.');
  }
  return o;
}

function trackOrder_(req) {
  var o = findCustomerOrder_(req);
  return {
    id: Number(o.id), status: String(o.status), mode: String(o.mode),
    table: o.table === '' ? 0 : Number(o.table), stationName: String(o.stationName || ''),
    total: Number(o.total), paymentMethod: String(o.paymentMethod),
    paymentStatus: String(o.paymentStatus), servedAt: String(o.servedAt||''), receiptCode: String(o.receiptCode||''), paymentProvider: String(o.paymentProvider||''), transactionId: String(o.transactionId||''), paymentProofUrl: String(o.paymentProofUrl||''), cashCode: String(o.cashCode||''), cashHandoverStatus: String(o.cashHandoverStatus||''), rejectReason: String(o.rejectReason || ''),
    assignedToName: String(o.assignedToName || ''), updatedAt: String(o.updatedAt),
    code: (o.mode === 'Delivery' && !toBool_(o.codeUsed)) ? String(o.code || '') : '',
    codeUsed: toBool_(o.codeUsed)
  };
}

function cancelMyOrder_(req) {
  var o = findCustomerOrder_(req);
  expect_(o, ['Pending'], 'This order has already been approved. Please call the restaurant to cancel.');
  if(String(o.paymentMethod)==='Wallet' && String(o.paymentStatus)==='Paid'){var acct=readTable_('CustomerAccounts').filter(function(a){return last9_(a.phone)===last9_(o.phone);})[0];if(acct)updateRow_('CustomerAccounts','phone',acct.phone,{walletBalance:num_(acct.walletBalance)+num_(o.total)});}
  setStatus_(o, { status: 'Cancelled', rejectReason: 'Cancelled by customer', codeUsed: true });
  audit_({ name: 'Customer', role: 'customer' }, 'Order cancelled', '#' + o.id);
  notify_(['manager', 'admin'], '', 'Order #' + o.id + ' cancelled', 'Cancelled by the customer', o.id, 'alert');
  return true;
}

// ------------------------------------------------------------------ inventory & stock
// Stock is always stored in the item's BASE unit (bottle, kg, number...).
// An item may also have a PACK (crate, sack, carton...) holding packSize base units.

var DEFAULT_LOW_PCT = 25;

function num_(v) { var n = Number(v); return isFinite(n) ? n : 0; }
function fmt_(n) { return String(Math.round(num_(n) * 100) / 100); }

function stockText_(stock, unit, packName, packSize) {
  stock = num_(stock);
  if (packName && packSize > 0 && stock >= packSize) {
    var packs = Math.floor(stock / packSize + 1e-9);
    var rem = Math.round((stock - packs * packSize) * 100) / 100;
    return fmt_(packs) + ' ' + packName + (rem > 0 ? ' + ' + fmt_(rem) + ' ' + unit : '') +
           ' (' + fmt_(stock) + ' ' + unit + ')';
  }
  return fmt_(stock) + ' ' + unit;
}

function invView_(x, includePrices) {
  var stock = num_(x.stock), minimum = num_(x.minimum);
  var packSize = num_(x.packSize), full = num_(x.fullLevel);
  var lowPct = num_(x.lowPct) > 0 ? num_(x.lowPct) : DEFAULT_LOW_PCT;
  if (!(full > 0)) full = stock;
  var pct = full > 0 ? Math.min(100, stock / full * 100) : (stock > 0 ? 100 : 0);
  var out = stock <= 0;
  var low = out || pct <= lowPct || (minimum > 0 && stock <= minimum);
  var v = {
    id: Number(x.id), name: String(x.name), unit: String(x.unit), stock: stock, minimum: minimum,
    packName: String(x.packName || ''), packSize: packSize, fullLevel: full, lowPct: lowPct,
    percent: Math.round(pct * 10) / 10, low: low, out: out,
    stockText: stockText_(stock, String(x.unit), String(x.packName || ''), packSize)
  };
  if (includePrices) {
    v.packPrice = num_(x.packPrice); v.unitPrice = num_(x.unitPrice);
    v.value = Math.round(stock * num_(x.unitPrice));
  }
  return v;
}

function listInventory_(req, user) {
  var prices = user && (user.role === 'admin' || user.role === 'manager');
  return readTable_('Inventory').map(function (x) { return invView_(x, prices); });
}

function cleanItemFields_(req, existing) {
  var f = {};
  var name = String(req.name !== undefined ? req.name : (existing ? existing.name : '')).trim();
  var unit = String(req.unit !== undefined ? req.unit : (existing ? existing.unit : '')).trim();
  if (!name || !unit) throw new Error('Item name and unit are required');
  if (name.length > 60 || unit.length > 30) throw new Error('Name or unit is too long');
  f.name = name; f.unit = unit;
  function pick(key, label) {
    if (req[key] === undefined) return existing ? existing[key] : '';
    var raw = String(req[key]).trim();
    if (raw === '') return '';
    var n = Number(raw);
    if (!(n >= 0)) throw new Error(label + ' must be a number');
    return n;
  }
  f.packName = String(req.packName !== undefined ? req.packName : (existing ? existing.packName : '')).trim().slice(0, 30);
  f.packSize = pick('packSize', 'Items per pack');
  f.packPrice = pick('packPrice', 'Pack price');
  f.unitPrice = pick('unitPrice', 'Single item price');
  f.lowPct = pick('lowPct', 'Low-stock warning level');
  f.minimum = pick('minimum', 'Minimum');
  if (f.packSize !== '' && f.packSize !== 0 && !(f.packSize > 0)) throw new Error('Items per pack must be more than zero');
  if (f.lowPct !== '' && f.lowPct > 100) throw new Error('Warning level is a percentage up to 100');
  if (f.unitPrice === '' && f.packPrice !== '' && f.packSize !== '' && f.packSize > 0) {
    f.unitPrice = Math.round(f.packPrice / f.packSize * 100) / 100;
  }
  if (f.packPrice === '' && f.unitPrice !== '' && f.packSize !== '' && f.packSize > 0 && f.packName) {
    f.packPrice = Math.round(f.unitPrice * f.packSize * 100) / 100;
  }
  return f;
}

function logMovement_(item, change, reason, user, kind, cost, balance) {
  appendRow_('StockMovements', { timestamp: now_(), itemId: item.id, name: item.name, change: change,
                                 reason: reason, by: user.name, kind: kind, unit: item.unit,
                                 cost: cost === undefined ? '' : cost, balance: balance });
}

function saveInventoryItem_(req, user) {
  if (req.id) {
    var old = findRow_('Inventory', 'id', req.id);
    if (!old) throw new Error('Stock item not found');
    var f = cleanItemFields_(req, old);
    f.updatedAt = now_();
    updateRow_('Inventory', 'id', req.id, f);
    audit_(user, 'Inventory item edited', f.name);
    return { id: Number(req.id) };
  }
  var fields = cleanItemFields_(req, null);
  var dup = readTable_('Inventory').filter(function (x) {
    return String(x.name).toLowerCase() === fields.name.toLowerCase();
  });
  if (dup.length) throw new Error('"' + fields.name + '" already exists. Use Add stock on it instead.');
  var stock = req.stock === undefined || req.stock === '' ? 0 : Number(req.stock);
  if (!(stock >= 0)) throw new Error('Enter valid quantities');
  var id = nextId_('Inventory', 'id', 1);
  fields.id = id; fields.stock = stock; fields.fullLevel = stock; fields.updatedAt = now_();
  appendRow_('Inventory', fields);
  if (stock > 0) logMovement_({ id: id, name: fields.name, unit: fields.unit }, stock, 'Opening stock', user, 'IN', '', stock);
  audit_(user, 'Inventory item added', fields.name);
  return { id: id };
}

function deleteInventoryItem_(req, user) {
  var it = findRow_('Inventory', 'id', req.id);
  if (!it) throw new Error('Stock item not found');
  deleteRow_('Inventory', 'id', req.id);
  audit_(user, 'Inventory item deleted', String(it.name));
  return true;
}

// Add stock to an existing item (itemId) or create it on the spot (name + unit).
// qtyUnit: 'base' (single items) or 'pack' (crates, sacks...).
function addStock_(req, user) {
  var qty = Number(req.qty);
  if (!(qty > 0)) throw new Error('Enter how many were bought');
  var qtyUnit = String(req.qtyUnit || 'base') === 'pack' ? 'pack' : 'base';
  var item;
  if (req.itemId) {
    item = findRow_('Inventory', 'id', req.itemId);
    if (!item) throw new Error('Stock item not found');
    var hasChange = ['unit', 'packName', 'packSize', 'packPrice', 'unitPrice', 'lowPct'].some(function (k) {
      return req[k] !== undefined && String(req[k]).trim() !== '';
    });
    if (hasChange) {
      var merged = {};
      ['name', 'unit', 'packName', 'packSize', 'packPrice', 'unitPrice', 'lowPct', 'minimum'].forEach(function (k) {
        merged[k] = (req[k] !== undefined && String(req[k]).trim() !== '') ? req[k] : item[k];
      });
      var nf = cleanItemFields_(merged, item);
      updateRow_('Inventory', 'id', item.id, nf);
      item = findRow_('Inventory', 'id', item.id);
    }
  } else {
    var created = saveInventoryItem_({
      name: req.name, unit: req.unit, packName: req.packName, packSize: req.packSize,
      packPrice: req.packPrice, unitPrice: req.unitPrice, lowPct: req.lowPct, stock: 0
    }, user);
    item = findRow_('Inventory', 'id', created.id);
  }
  var packSize = num_(item.packSize);
  var base = qty;
  if (qtyUnit === 'pack') {
    if (!(packSize > 0)) throw new Error('Say how many ' + item.unit + ' are in one ' + (item.packName || 'pack') + ' first');
    base = qty * packSize;
  }
  var cost = '';
  if (qtyUnit === 'pack' && item.packPrice !== '' && num_(item.packPrice) > 0) cost = Math.round(qty * num_(item.packPrice));
  else if (item.unitPrice !== '' && num_(item.unitPrice) > 0) cost = Math.round(base * num_(item.unitPrice));
  var newStock = Math.round((num_(item.stock) + base) * 1000) / 1000;
  // A restock sets the new "full" level, which the low-stock percentage is measured against.
  updateRow_('Inventory', 'id', item.id, { stock: newStock, fullLevel: newStock, updatedAt: now_() });
  var reason = String(req.note || '').trim().slice(0, 100) || 'Purchase';
  logMovement_(item, base, reason + (qtyUnit === 'pack' ? ' (' + fmt_(qty) + ' ' + (item.packName || 'pack') + ')' : ''),
               user, 'IN', cost, newStock);
  audit_(user, 'Stock added', item.name + ' +' + fmt_(base) + ' ' + item.unit);
  return invView_(findRow_('Inventory', 'id', item.id), true);
}

// Items used (by the kitchen, or recorded by the manager). Subtracts from stock.
function useStock_(req, user) {
  var list = Array.isArray(req.items) ? req.items : [];
  if (!list.length) throw new Error('Choose at least one item');
  if (list.length > 40) throw new Error('Too many items at once');
  var wanted = {};
  list.forEach(function (x) {
    var item = findRow_('Inventory', 'id', x.id);
    if (!item) throw new Error('A stock item no longer exists');
    var qty = Number(x.qty);
    if (!(qty > 0)) throw new Error('Enter a quantity for ' + item.name);
    var unit = String(x.qtyUnit || 'base') === 'pack' ? 'pack' : 'base';
    var base = qty;
    if (unit === 'pack') {
      if (!(num_(item.packSize) > 0)) throw new Error(item.name + ' has no pack size set');
      base = qty * num_(item.packSize);
    }
    wanted[String(item.id)] = (wanted[String(item.id)] || 0) + base;
  });
  Object.keys(wanted).forEach(function (id) {
    var item = findRow_('Inventory', 'id', id);
    if (wanted[id] > num_(item.stock) + 1e-9) {
      throw new Error('Not enough ' + item.name + ' in stock. Available: ' +
        stockText_(item.stock, item.unit, item.packName, num_(item.packSize)));
    }
  });
  var note = String(req.note || '').trim().slice(0, 80);
  var reason = (user.role === 'kitchen' ? 'Used in kitchen' : 'Used (recorded by ' + user.role + ')') + (note ? ': ' + note : '');
  var done = [];
  Object.keys(wanted).forEach(function (id) {
    var item = findRow_('Inventory', 'id', id);
    var before = invView_(item, false);
    var newStock = Math.round((num_(item.stock) - wanted[id]) * 1000) / 1000;
    updateRow_('Inventory', 'id', id, { stock: newStock, updatedAt: now_() });
    logMovement_(item, -wanted[id], reason, user, 'OUT', '', newStock);
    var after = invView_(findRow_('Inventory', 'id', id), false);
    if (after.out && !before.out) {
      notify_(['manager', 'admin'], '', 'Out of stock: ' + item.name, 'There is none left. Please buy more.', '', 'stock');
    } else if (after.low && !before.low) {
      notify_(['manager', 'admin'], '', 'Low stock: ' + item.name,
              'Only ' + after.stockText + ' left (' + Math.round(after.percent) + '%).', '', 'stock');
    }
    done.push(after);
  });
  audit_(user, 'Stock used', Object.keys(wanted).map(function (id) {
    var it = findRow_('Inventory', 'id', id); return it.name + ' -' + fmt_(wanted[id]);
  }).join(', '));
  return { updated: done };
}

function adjustStock_(req, user) {
  var item = findRow_('Inventory', 'id', req.id);
  if (!item) throw new Error('Stock item not found');
  var change = Number(req.change);
  if (!isFinite(change) || change === 0) throw new Error('Enter a quantity to add or remove');
  var newStock = Number(item.stock) + change;
  if (newStock < 0) throw new Error('Stock cannot go below zero');
  var reason = String(req.reason || 'Adjustment').slice(0, 100);
  var upd = { stock: newStock, updatedAt: now_() };
  if (newStock > num_(item.fullLevel)) upd.fullLevel = newStock;
  updateRow_('Inventory', 'id', req.id, upd);
  logMovement_(item, change, reason, user, 'ADJ', '', newStock);
  audit_(user, 'Inventory adjustment', item.name + ' ' + (change > 0 ? '+' : '') + change + ' (' + reason + ')');
  return { stock: newStock };
}

function listStockMovements_(req) {
  var rows = readTable_('StockMovements');
  if (req.itemId) rows = rows.filter(function (m) { return String(m.itemId) === String(req.itemId); });
  return rows.reverse().slice(0, 200).map(function (m) {
    return { timestamp: String(m.timestamp), name: String(m.name), change: num_(m.change),
             unit: String(m.unit || ''), reason: String(m.reason), by: String(m.by),
             kind: String(m.kind || ''), cost: m.cost === '' ? 0 : num_(m.cost), balance: m.balance === '' ? 0 : num_(m.balance) };
  });
}

// Data for the stock graphs: levels now + usage per day for the last N days.
function stockReport_(req) {
  var days = Math.max(3, Math.min(60, Math.floor(Number(req.days || 14))));
  var items = readTable_('Inventory');
  var views = items.map(function (x) { return invView_(x, true); });
  var labels = [], keys = [];
  for (var i = days - 1; i >= 0; i--) {
    var k = daysAgoStr_(i);
    keys.push(k); labels.push(k.slice(5));
  }
  var index = {};
  keys.forEach(function (k, i) { index[k] = i; });
  var byItem = {}, perDayValue = keys.map(function () { return 0; });
  var priceOf = {};
  items.forEach(function (x) { priceOf[String(x.id)] = num_(x.unitPrice); });
  readTable_('StockMovements').forEach(function (m) {
    if (String(m.kind) !== 'OUT') return;
    var d = String(m.timestamp).slice(0, 10);
    if (index[d] === undefined) return;
    var key = String(m.itemId);
    var e = byItem[key] = byItem[key] || { id: Number(m.itemId), name: String(m.name), unit: String(m.unit || ''),
                                            series: keys.map(function () { return 0; }), total: 0 };
    var used = Math.abs(num_(m.change));
    e.series[index[d]] += used; e.total += used;
    perDayValue[index[d]] += used * (priceOf[key] || 0);
  });
  var value = 0, low = 0, out = 0;
  views.forEach(function (v) { value += v.value || 0; if (v.low) low++; if (v.out) out++; });
  return {
    days: labels, items: views,
    usage: Object.keys(byItem).map(function (k) {
      var e = byItem[k];
      e.series = e.series.map(function (n) { return Math.round(n * 100) / 100; });
      e.total = Math.round(e.total * 100) / 100;
      return e;
    }),
    usageValue: perDayValue.map(function (n) { return Math.round(n); }),
    summary: { items: views.length, low: low, out: out, stockValue: Math.round(value) }
  };
}

// ------------------------------------------------------------------ notifications
// Messages are stored per role (or per person). The app asks for new ones every few
// seconds and shows them as phone notifications.

function notify_(roles, userId, title, body, orderId, kind) {
  try {
    appendRow_('Notifications', {
      id: nextId_('Notifications', 'id', 1), timestamp: now_(),
      roles: (roles || []).join(','), userId: userId === undefined ? '' : userId,
      title: String(title).slice(0, 80), body: String(body || '').slice(0, 200),
      orderId: orderId === undefined ? '' : orderId, kind: kind || 'info'
    });
    var s = sheet_('Notifications');
    if (s.getLastRow() > 700) s.deleteRows(2, 300);   // keep the sheet small
  } catch (e) { /* a failed notification must never break the real action */ }
}

function listNotifications_(req, user) {
  var rows = readTable_('Notifications').filter(function (n) {
    if (String(n.userId) !== '') return String(n.userId) === String(user.id);
    return String(n.roles).split(',').indexOf(user.role) >= 0;
  });
  return rows.slice(-40).reverse().map(function (n) {
    return { id: Number(n.id), timestamp: String(n.timestamp), title: String(n.title),
             body: String(n.body), orderId: n.orderId === '' ? 0 : Number(n.orderId), kind: String(n.kind) };
  });
}

function sendNotification_(req, user) {
  var roles = (Array.isArray(req.roles) ? req.roles : []).filter(function (r) { return ROLES.indexOf(r) >= 0; });
  var title = String(req.title || '').trim();
  if (!roles.length) throw new Error('Choose who should receive it');
  if (!title) throw new Error('Write a title');
  notify_(roles, '', title, String(req.body || ''), '', 'broadcast');
  audit_(user, 'Notification sent', title + ' -> ' + roles.join(','));
  return true;
}

function saveHeroImages_(req, user) {
  var list = Array.isArray(req.images) ? req.images : [];
  var clean = [];
  list.forEach(function (u) {
    u = String(u || '').trim();
    if (/^https:\/\//.test(u) && u.length < 500) clean.push(u);
  });
  if (clean.length > 12) throw new Error('At most 12 background pictures');
  setSetting_('heroImages', JSON.stringify(clean));
  audit_(user, 'Background pictures updated', String(clean.length));
  return { images: clean };
}

// ------------------------------------------------------------------ delivery codes
// Every delivery order gets a short random code (8 characters). The customer shows it
// to the delivery man, who enters it on his phone. It works ONCE.

var CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';   // no 0/O/1/I/L

function newDeliveryCode_() {
  var used = {};
  readTable_('Orders').forEach(function (o) { if (o.code) used[String(o.code)] = true; });
  for (var tries = 0; tries < 50; tries++) {
    var c = '';
    for (var i = 0; i < 8; i++) c += CODE_ALPHABET.charAt(Math.floor(Math.random() * CODE_ALPHABET.length));
    if (!used[c]) return c;
  }
  throw new Error('Could not make a code. Please try again.');
}

function amountDue_(o) {
  var due = o.paymentStatus !== 'Paid' && (o.paymentMethod === 'Pay on Delivery' || o.paymentMethod === 'Cash');
  return due ? Number(o.total) : 0;
}

function deliveryForCode_(req, user) {
  var code = String(req.code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code.length < 4 || code.length > 10) throw new Error('Enter the code the customer shows you');
  var cache = CacheService.getScriptCache();
  var key = 'codefail_' + user.id;
  var fails = Number(cache.get(key) || 0);
  if (fails >= 8) throw new Error('Too many wrong codes. Wait 10 minutes and try again.');
  var o = null;
  readTable_('Orders').forEach(function (r) { if (String(r.code) === code) o = r; });
  var problem = '';
  if (!o) problem = 'That code is not valid.';
  else if (toBool_(o.codeUsed)) problem = 'This code was already used. The order is closed.';
  else if (o.status !== 'Assigned') problem = 'Order #' + o.id + ' is ' + o.status + ' and cannot be handed over now.';
  else if (String(o.assignedToId) !== String(user.id)) problem = 'This order was given to another delivery man.';
  if (problem) {
    cache.put(key, String(fails + 1), LOCKOUT_SECONDS);
    throw new Error(problem);
  }
  return o;
}

function deliveryDetails_(o) {
  var lines = itemsByOrder_()[String(o.id)] || [];
  return {
    id: Number(o.id), customer: String(o.customer), phone: String(o.phone),
    stationName: String(o.stationName || ''), mode: String(o.mode), lines: lines,
    payment: String(o.paymentMethod), paymentStatus: String(o.paymentStatus), paymentProvider: String(o.paymentProvider||''), transactionId: String(o.transactionId||''), paymentProofUrl: String(o.paymentProofUrl||''),
    subtotal: Number(o.subtotal), deliveryFee: Number(o.deliveryFee), total: Number(o.total),
    amountDue: amountDue_(o), deliveryNote: String(o.deliveryNote || ''), note: String(o.note || '')
  };
}

function lookupDeliveryCode_(req, user) {
  var o = deliveryForCode_(req, user);
  return deliveryDetails_(o);
}

function confirmDelivery_(req, user) {
  var o = deliveryForCode_(req, user);
  var due = amountDue_(o);
  if (due > 0 && req.collected !== true) {
    throw new Error('Collect UGX ' + due + ' from the customer first, then confirm.');
  }
  var changes = { status: 'Completed', completedBy: user.name, completedAt: now_(),
                  codeUsed: true, codeUsedAt: now_(), amountCollected: due > 0 ? due : 0 };
  if (due > 0) changes.paymentStatus = 'Paid';
  setStatus_(o, changes);
  CacheService.getScriptCache().remove('codefail_' + user.id);
  audit_(user, 'Delivery confirmed by code', '#' + o.id + (due > 0 ? ' collected UGX ' + due : ''));
  notify_(['manager', 'admin'], '', 'Order #' + o.id + ' delivered',
          'Handed over by ' + user.name + (due > 0 ? ' - collected UGX ' + due : ''), o.id, 'order');
  return { id: Number(o.id), collected: due };
}

function listMyDone_(req, user) {
  return viewOrders_(function (o) {
    return o.status === 'Completed' && String(o.assignedToId) === String(user.id);
  }, 50, true, false);
}

function listSubscribers_() {
  return readTable_('Customers').filter(function (c) { return toBool_(c.whatsappOptIn); })
      .map(function (c) { return { phone: String(c.phone), name: String(c.name) }; });
}

function saveCustomer_(phone, name, optIn) {
  var existing = findRow_('Customers', 'phone', phone);
  if (existing) {
    var upd = {};
    if (name) upd.name = name;
    if (optIn && !toBool_(existing.whatsappOptIn)) { upd.whatsappOptIn = true; upd.optInDate = now_(); }
    if (Object.keys(upd).length) updateRow_('Customers', 'phone', phone, upd);
  } else {
    appendRow_('Customers', { phone: phone, name: name, whatsappOptIn: optIn, optInDate: optIn ? now_() : '' });
  }
}

// ----------------------------------------------------------------- statistics

function pad2_(n) { return (n < 10 ? '0' : '') + n; }
function ymd_(d) { return d.getFullYear() + '-' + pad2_(d.getMonth() + 1) + '-' + pad2_(d.getDate()); }
function parseYmd_(s) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) throw new Error('Invalid date');
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0);
}
function parseStamp_(s) {
  var m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(String(s || ''));
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])) : null;
}
function daysAgoStr_(n) {
  var d = new Date();
  d.setDate(d.getDate() - n);
  return Utilities.formatDate(d, TIMEZONE, 'yyyy-MM-dd');
}

var MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Statistics are built from COMPLETED orders (approved, cooked and handed over).
 * mode 'day'   : from, to (yyyy-MM-dd, max 92 days)
 * mode 'month' : year
 * mode 'year'  : all years that have orders
 */
function stats_(req, user) {
  var mode = String(req.mode || 'day');
  var done = readTable_('Orders').filter(function (o) { return o.status === 'Completed'; });
  var servingsByOrder = {};
  var itemRows = readTable_('OrderItems');
  itemRows.forEach(function (x) {
    servingsByOrder[String(x.orderId)] = (servingsByOrder[String(x.orderId)] || 0) + Number(x.servings);
  });
  function dateOf(o) { return String(o.completedAt || o.createdAt); }

  var buckets = [], keyOf, from = '', to = '';
  if (mode === 'month') {
    var year = Math.floor(Number(req.year)) || new Date().getFullYear();
    for (var m = 0; m < 12; m++) buckets.push({ key: year + '-' + pad2_(m + 1), label: MONTH_NAMES[m] });
    keyOf = function (o) { return dateOf(o).slice(0, 7); };
    from = year + '-01-01'; to = year + '-12-31';
  } else if (mode === 'year') {
    var years = {};
    done.forEach(function (o) { years[dateOf(o).slice(0, 4)] = true; });
    var thisYear = String(new Date().getFullYear());
    years[thisYear] = true;
    Object.keys(years).sort().forEach(function (y) { buckets.push({ key: y, label: y }); });
    keyOf = function (o) { return dateOf(o).slice(0, 4); };
    from = buckets[0].key + '-01-01'; to = buckets[buckets.length - 1].key + '-12-31';
  } else {
    var end = req.to ? parseYmd_(req.to) : new Date();
    end.setHours(12, 0, 0, 0);
    var start = req.from ? parseYmd_(req.from) : new Date(end.getTime() - 13 * 86400000);
    start.setHours(12, 0, 0, 0);
    if (start > end) throw new Error('The start date must be before the end date');
    var span = Math.round((end - start) / 86400000) + 1;
    if (span > 92) throw new Error('Choose at most 92 days at a time');
    for (var i = 0; i < span; i++) {
      var d = new Date(start.getTime() + i * 86400000);
      d.setHours(12, 0, 0, 0);
      buckets.push({ key: ymd_(d), label: pad2_(d.getMonth() + 1) + '-' + pad2_(d.getDate()) });
    }
    keyOf = function (o) { return dateOf(o).slice(0, 10); };
    from = buckets[0].key; to = buckets[buckets.length - 1].key;
  }

  var series = buckets.map(function (b) { return { key: b.key, label: b.label, sales: 0, orders: 0, servings: 0 }; });
  var index = {};
  series.forEach(function (s, i) { index[s.key] = i; });

  var inPeriod = [], ids = {};
  var totals = { sales: 0, orders: 0, servings: 0 };
  var byPayment = {}, byMode = {};
  done.forEach(function (o) {
    var k = keyOf(o);
    if (index[k] === undefined) return;
    var s = series[index[k]];
    var total = Number(o.total);
    var sv = servingsByOrder[String(o.id)] || 0;
    s.sales += total; s.orders += 1; s.servings += sv;
    totals.sales += total; totals.orders += 1; totals.servings += sv;
    byPayment[o.paymentMethod] = (byPayment[o.paymentMethod] || 0) + total;
    byMode[o.mode] = (byMode[o.mode] || 0) + total;
    inPeriod.push(o); ids[String(o.id)] = true;
  });

  var sold = {};
  itemRows.forEach(function (x) {
    if (!ids[String(x.orderId)]) return;
    var key = x.kind + ':' + x.name;
    var e = sold[key] = sold[key] || { name: String(x.name), kind: String(x.kind), qty: 0, servings: 0, total: 0 };
    e.qty += Number(x.qty); e.servings += Number(x.servings); e.total += Number(x.lineTotal);
  });
  var best = Object.keys(sold).map(function (k) { return sold[k]; })
      .sort(function (a, b) { return b.qty - a.qty; }).slice(0, 8);

  // Order outcomes for orders placed in the same period.
  var outcomes = { placed: 0, rejected: 0, cancelled: 0, failed: 0 };
  readTable_('Orders').forEach(function (o) {
    var k = String(o.createdAt).slice(0, mode === 'month' ? 7 : mode === 'year' ? 4 : 10);
    if (index[k] === undefined) return;
    outcomes.placed++;
    if (o.status === 'Rejected') outcomes.rejected++;
    if (o.status === 'Cancelled') outcomes.cancelled++;
    if (o.status === 'Failed') outcomes.failed++;
  });

  var minutes = 0, timed = 0;
  inPeriod.forEach(function (o) {
    var a = parseStamp_(o.createdAt), b = parseStamp_(o.completedAt);
    if (a && b && b >= a) { minutes += (b - a) / 60000; timed++; }
  });

  var result = {
    mode: mode, from: from, to: to, series: series, totals: totals,
    averageOrder: totals.orders ? Math.round(totals.sales / totals.orders) : 0,
    averageMinutes: timed ? Math.round(minutes / timed) : 0,
    byPayment: byPayment, byMode: byMode, bestSellers: best, outcomes: outcomes,
    lowStockCount: readTable_('Inventory').filter(function (x) { return invView_(x, false).low; }).length
  };

  if (user && ['admin','manager'].indexOf(user.role)>=0) {
    var staff = {};
    readTable_('Users').filter(function(u){return toBool_(u.active);}).forEach(function(u){staff[String(u.name)+'|'+String(u.role)]={name:String(u.name),role:String(u.role),approved:0,cooked:0,handedOver:0,sales:0,tasksCompleted:0,tasksAssigned:0};});
    var who = function (name, role) {
      if (!name) return null;
      var k = name + '|' + role;
      return staff[k] = staff[k] || { name: String(name), role: role, approved: 0, cooked: 0, handedOver: 0, sales: 0 };
    };
    inPeriod.forEach(function (o) {
      var a = who(o.approvedBy, 'manager'); if (a) a.approved++;
      var c = who(o.cookedBy, 'kitchen'); if (c) c.cooked++;
      var h = who(o.completedBy, o.mode === 'Delivery' ? 'delivery' : 'waiter');
      if (h) { h.handedOver++; h.sales += Number(o.total); }
    });
    readTable_('Workday').forEach(function(w){var k=String(w.name)+'|'+String(w.role);if(staff[k]){staff[k].tasksCompleted+=num_(w.tasksCompleted);staff[k].tasksAssigned+=num_(w.tasksAssigned);}});
    result.staff = Object.keys(staff).map(function (k) { return staff[k]; });
  }
  return result;
}

// ------------------------------------------------------------- sheet helpers

function sheet_(name) {
  var s = SpreadsheetApp.getActive().getSheetByName(name);
  if (!s) throw new Error('Sheet "' + name + '" is missing. Run setupSheets once.');
  return s;
}

function readTable_(name) {
  var s = sheet_(name);
  var last = s.getLastRow();
  if (last < 2) return [];
  var headers = SHEETS[name];
  var values = s.getRange(2, 1, last - 1, headers.length).getValues();
  return values.filter(function (r) { return r.join('') !== ''; }).map(function (r) {
    var o = {};
    headers.forEach(function (h, i) { o[h] = r[i]; });
    return o;
  });
}

function appendRow_(name, obj) {
  var headers = SHEETS[name];
  sheet_(name).appendRow(headers.map(function (h) { return obj[h] === undefined ? '' : obj[h]; }));
}

function findRow_(name, key, value) {
  var rows = readTable_(name);
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][key]) === String(value)) return rows[i];
  }
  return null;
}

function rowIndex_(name, key, value) {
  var s = sheet_(name);
  var last = s.getLastRow();
  if (last < 2) return -1;
  var col = SHEETS[name].indexOf(key);
  var keys = s.getRange(2, col + 1, last - 1, 1).getValues();
  for (var i = 0; i < keys.length; i++) {
    if (String(keys[i][0]) === String(value)) return i + 2;
  }
  return -1;
}

function updateRow_(name, key, value, changes) {
  var row = rowIndex_(name, key, value);
  if (row < 0) throw new Error('Row not found');
  var s = sheet_(name), headers = SHEETS[name];
  Object.keys(changes).forEach(function (field) {
    var col = headers.indexOf(field);
    if (col >= 0) s.getRange(row, col + 1).setValue(changes[field]);
  });
}

function deleteRow_(name, key, value) {
  var row = rowIndex_(name, key, value);
  if (row < 0) throw new Error('Row not found');
  sheet_(name).deleteRow(row);
}

function nextId_(name, key, start) {
  var max = start - 1;
  readTable_(name).forEach(function (r) { var n = Number(r[key]); if (n > max) max = n; });
  return max + 1;
}

function getSetting_(key, fallback) {
  var r = findRow_('Settings', 'key', key);
  return r ? r.value : fallback;
}

function setSetting_(key, value) {
  if (findRow_('Settings', 'key', key)) updateRow_('Settings', 'key', key, { value: value });
  else appendRow_('Settings', { key: key, value: value });
}

function audit_(user, action, details) {
  appendRow_('Audit', { timestamp: now_(), user: user ? user.name : '', role: user ? user.role : '',
                        action: action, details: details });
}

function now_() { return Utilities.formatDate(new Date(), TIMEZONE, 'yyyy-MM-dd HH:mm:ss'); }

function toBool_(v) { return v === true || String(v).toLowerCase() === 'true'; }



function serveOrder_(req,user){var o=getOrder_(req.id);expect_(o,['Assigned'],'This order is not assigned yet.');if(user.role!=='admin'&&user.role!=='manager'&&!isAssignee_(o,user))throw new Error('This order is assigned to another worker.');if(o.mode==='Indoor'&&o.paymentMethod==='Cash'&&String(o.cashHandoverStatus)!=='Cash received by manager')throw new Error('Cash must be handed to the manager before serving this order.');setStatus_(o,{servedAt:now_()});audit_(user,'Food served - awaiting customer receipt','#'+o.id);return true;}
function customerReceiveFood_(req){var o=findCustomerOrder_(req);if(o.mode==='Delivery')throw new Error('Use the delivery code for delivery orders.');if(o.status!=='Assigned'||!String(o.servedAt||''))throw new Error('The waiter has not marked this food as served yet.');if(!String(o.receiptCode||'')){var code=String(Math.floor(100000+Math.random()*900000));setStatus_(o,{receiptCode:code});o.receiptCode=code;}return {orderId:Number(o.id),receiptCode:String(o.receiptCode),status:String(o.status)};}
function waiterCashCollected_(req,user){var o=getOrder_(req.id);if(!isAssignee_(o,user))throw new Error('This order is assigned to another waiter.');if(o.mode!=='Indoor'||o.paymentMethod!=='Cash')throw new Error('This cash collection flow applies only to indoor cash orders.');if(!String(o.cashCode||'')||String(req.code||'')!==String(o.cashCode))throw new Error('Invalid customer order code.');if(String(o.cashHandoverStatus)==='Cash received by manager')throw new Error('Cash was already confirmed by manager.');setStatus_(o,{cashHandoverStatus:'Waiter reported collected'});audit_(user,'Waiter cash collected','#'+o.id);notify_(['manager','admin'],'','Cash handover required','Waiter '+user.name+' reports cash collected for order #'+o.id+'. Present cash and code.',o.id,'payment');return true;}
function confirmCashHandover_(req,user){var o=getOrder_(req.id);if(o.mode!=='Indoor'||o.paymentMethod!=='Cash')throw new Error('This is not an indoor cash order.');if(String(o.cashHandoverStatus)!=='Waiter reported collected')throw new Error('Waiter has not reported cash collection yet.');if(String(req.code||'')!==String(o.cashCode))throw new Error('Order code does not match.');setStatus_(o,{cashHandoverStatus:'Cash received by manager',managerCashConfirmedAt:now_(),cashPresentedBy:String(o.assignedToName||''),paymentStatus:'Paid'});audit_(user,'Cash received from waiter','#'+o.id+' UGX '+o.total);return true;}

// ---------------------------------------------------------------- extended restaurant workflows
// Generic records keep new modules additive: existing orders and stock schemas remain intact.
function staffCheckOrder_(req,user){var id=Number(req.orderId||req.id||req.title),code=String(req.code||req.relatedId||'').trim(),o=findRow_('Orders','id',id);if(!o||!code||[String(o.code||''),String(o.cashCode||''),String(o.receiptCode||'')].indexOf(code)<0)throw new Error('Invalid order code or order number.');return {valid:true,id:Number(o.id),status:String(o.status),paymentStatus:String(o.paymentStatus),paymentMethod:String(o.paymentMethod),total:num_(o.total),assignedToName:String(o.assignedToName||''),completedAt:String(o.completedAt||'')};}
function featureType_(v) { return String(v || '').trim().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40); }
function featureView_(r) { return { id:Number(r.id), type:String(r.type||''), title:String(r.title||''), details:String(r.details||''), amount:num_(r.amount), quantity:num_(r.quantity), status:String(r.status||'Pending'), ownerId:String(r.ownerId||''), ownerName:String(r.ownerName||''), relatedId:String(r.relatedId||''), code:String(r.code||''), payload:String(r.payload||''), createdAt:String(r.createdAt||''), updatedAt:String(r.updatedAt||'') }; }
function featureList_(req, user) {
  var type = featureType_(req.type), rows = readTable_('FeatureRecords');
  if(type==='eventCheckin') rows=rows.filter(function(r){return String(r.type)==='eventBooking' && String(r.status)==='Confirmed';}); else if (type) rows = rows.filter(function(r){return String(r.type)===type;});
  if (user.role === 'waiter' || user.role === 'delivery') rows = rows.filter(function(r){return String(r.ownerId)===String(user.id) || ['event','eventBooking','subscriptionPackage','subscriptionUse','menuBackground','social','restaurantInfo'].indexOf(String(r.type))>=0;});
  if (user.role === 'kitchen') rows = rows.filter(function(r){return ['kitchenRequest','stockRequest','menuBackground'].indexOf(String(r.type))>=0;});
  return rows.sort(function(a,b){return Number(b.id)-Number(a.id);}).slice(0,500).map(featureView_);
}
function listPublicFeatures_(req) {
  var allowed=['event','subscriptionPackage','menuBackground','social','restaurantInfo','tokenReward','paymentConfig'];
  return readTable_('FeatureRecords').filter(function(r){return allowed.indexOf(String(r.type))>=0 && String(r.status).toLowerCase()!=='deleted';}).sort(function(a,b){return Number(b.id)-Number(a.id);}).slice(0,200).map(featureView_);
}
function nextFeatureId_(){ return readTable_('FeatureRecords').reduce(function(m,r){return Math.max(m,Number(r.id)||0);},0)+1; }
function saveFeatureRecord_(req,user,publicCustomer) {
  var type=featureType_(req.type), title=String(req.title||'').trim();
  if(!type || !title) throw new Error('Feature type and title are required.');
  if(title.length>180) throw new Error('Title is too long.');
  var customerTypes=['eventBooking','walletTopup','mobilePayment','subscriptionPurchase','customerFeedback','loyaltyRedemption','customerProfile'];
  var staffOnly=['social','restaurantInfo','menuBackground','tokenReward','subscriptionPackage','event','paymentConfig','tableCodeConfig','staffShift'];
  if(publicCustomer && staffOnly.indexOf(type)>=0) throw new Error('Only staff can manage this setting.');
  var status=String(req.status||'Pending'), rowCode='';
  if(publicCustomer && ['Confirmed','Approved','Paid','Completed'].indexOf(status)>=0) status='Pending';
  if(type==='mobilePayment' && !String(req.transactionId||'').trim() && !String(req.screenshotUrl||'').trim() && !String(req.details||'').trim()) throw new Error('Enter a transaction ID or upload payment proof.');
  if(publicCustomer && type==='subscriptionUse'){var sub=readTable_('FeatureRecords').filter(function(r){return String(r.type)==='subscriptionPurchase'&&String(r.ownerId)===String(req.phone)&&String(r.relatedId)===String(req.relatedId)&&String(r.status)==='Confirmed';})[0];if(!sub)throw new Error('No confirmed subscription for this package.');rowCode=Utilities.getUuid().replace(/-/g,'').substring(0,8).toUpperCase();}
  var row={id:nextFeatureId_(),type:type,title:title,details:String(req.details||'').slice(0,5000),amount:Math.max(0,num_(req.amount)),quantity:Math.max(0,num_(req.quantity)),status:status,ownerId:publicCustomer?String(req.phone||''):String(user.id),ownerName:publicCustomer?String(req.customerName||'Customer'):String(user.name||user.username||user.id),relatedId:String(req.relatedId||''),code:rowCode,payload:JSON.stringify(req.payload||{}),createdAt:now_(),updatedAt:now_()};

  if(type==='walletTopup' || type==='mobilePayment' || type==='subscriptionPurchase' || type==='eventBooking') row.status='Awaiting manager verification'; if(type==='subscriptionUse') row.status='Code issued';
  appendRow_('FeatureRecords',row); audit_(user||{name:row.ownerName,role:'customer'},'feature.create',type+': '+title);
  if(!publicCustomer) notify_(['admin','manager'],'','New '+type+' request',title+' requires review.',row.id,type);
  else notify_(['admin','manager'],'','Customer '+type+' request',title+' requires review.',row.id,type);
  return featureView_(row);
}
function featureSave_(req,user){
  var type=featureType_(req.type);
  if(user.role==='kitchen' && ['kitchenRequest','stockRequest'].indexOf(type)<0) throw new Error('Kitchen staff can only submit kitchen stock requests.');
  if(user.role==='waiter' && ['cashHandover','mobilePayment','eventCheckin','orderCheck'].indexOf(type)<0) throw new Error('Waiters cannot create this record type.');
  return saveFeatureRecord_(req,user,false);
}
function customerFeatureSave_(req){
  var u=authenticateCustomer_(req); req.customerName=u.name; req.phone=u.phone;
  return saveFeatureRecord_(req,null,true);
}
function customerFeatureList_(req){
  var u=authenticateCustomer_(req), phone=String(u.phone);
  return readTable_('FeatureRecords').filter(function(r){return String(r.ownerId)===phone;}).sort(function(a,b){return Number(b.id)-Number(a.id);}).map(featureView_);
}
function featureAction_(req,user){
  var id=Number(req.id), action=String(req.actionName||''), rows=readTable_('FeatureRecords'), found=null;
  rows.forEach(function(r){if(Number(r.id)===id) found=r;}); if(!found) throw new Error('Feature record not found.');
  if(['waiter','delivery'].indexOf(user.role)>=0 && String(found.ownerId)!==String(user.id) && ['eventCheckin','orderCheck'].indexOf(found.type)<0) throw new Error('This record is assigned to another worker.');
  var status=String(found.status||'Pending');
  if(action==='approvePayment' || action==='confirmCash' || action==='confirmEventPayment' || action==='approveWallet' || action==='approveSubscription') {
    if(['admin','manager'].indexOf(user.role)<0) throw new Error('Only manager/admin can confirm money received.');
    if(action==='confirmCash' && !String(req.orderCode||'').trim()) throw new Error('Present the matching order code before confirming cash.');
    if(action==='confirmCash' && String(req.orderCode)!==String(found.relatedId) && String(req.orderCode)!==String(found.code)) throw new Error('Order code does not match this cash handover.');
    status='Confirmed';
  } else if(action==='reject') { if(['admin','manager'].indexOf(user.role)<0) throw new Error('Only manager/admin can reject requests.'); status='Rejected'; }
  else if(action==='serveFood') { if(user.role!=='waiter' && user.role!=='manager' && user.role!=='admin') throw new Error('Waiter access required.'); status='Awaiting customer receipt'; found.code=Utilities.getUuid().replace(/-/g,'').substring(0,8).toUpperCase(); }
  else if(action==='receiveFood') { if(String(req.code||'')!==String(found.code||'')) throw new Error('Invalid receipt code.'); status='Completed'; }
  else if(action==='checkIn') { if(['admin','manager','waiter'].indexOf(user.role)<0) throw new Error('Not permitted to check event/subscription codes.'); if(String(req.code||'')!==String(found.code||'')) throw new Error('Invalid event/subscription code.'); status=found.type==='subscriptionUse'?'Subscription used':'Checked in'; }
  else if(action==='redeem') { if(['admin','manager'].indexOf(user.role)<0) throw new Error('Manager confirmation required for redemption.'); var acctR=readTable_('CustomerAccounts').filter(function(a){return String(a.phone)===String(found.ownerId);})[0];if(!acctR)throw new Error('Customer account not found.');var cost=Math.max(0,num_(found.quantity));if(num_(acctR.tokens)<cost)throw new Error('Customer does not have enough tokens.');updateRow_('CustomerAccounts','phone',acctR.phone,{tokens:num_(acctR.tokens)-cost});status='Redeemed'; }
  else if(action==='completeTask') { status='Completed'; }
  else throw new Error('Unsupported feature action.');
  if(status==='Confirmed' && ['eventBooking','subscriptionPurchase'].indexOf(String(found.type))>=0 && !String(found.code||'')) found.code=Utilities.getUuid().replace(/-/g,'').substring(0,8).toUpperCase();
  if(status==='Confirmed' && ['walletTopup','subscriptionPurchase','eventBooking'].indexOf(String(found.type))>=0) { var ph=String(found.ownerId||''); var acct=readTable_('CustomerAccounts').filter(function(a){return String(a.phone)===ph;})[0]; if(acct && action==='approveWallet' && String(found.payload||'').indexOf('walletCredited')<0){ updateRow_('CustomerAccounts','phone',ph,{walletBalance:num_(acct.walletBalance)+num_(found.amount)}); found.payload=JSON.stringify({walletCredited:true}); } if(found.type==='walletTopup' && acct && action==='approvePayment' && String(found.payload||'').indexOf('walletCredited')<0){updateRow_('CustomerAccounts','phone',ph,{walletBalance:num_(acct.walletBalance)+num_(found.amount)});found.payload=JSON.stringify({walletCredited:true});} }
  found.status=status; found.updatedAt=now_(); updateRow_('FeatureRecords','id',id,found); audit_(user,'feature.'+action,'record '+id+' -> '+status);
  notify_(['admin','manager'],'','Feature updated',found.title+' is now '+status+'.',id,found.type);
  return featureView_(found);
}
function awardOrderTokens_(o){
  try { var phone=String(o.phone||'').replace(/[^0-9]/g,''); var acct=readTable_('CustomerAccounts').filter(function(a){return last9_(a.phone)===last9_(phone);})[0]; if(!acct)return; var rewards=readTable_('FeatureRecords').filter(function(r){return String(r.type)==='tokenReward' && String(r.status).toLowerCase()!=='deleted';}); var earned=0; rewards.forEach(function(r){var m=String(r.details||r.title||'').match(/(\d+)\s*[-–]\s*(\d+)\s*=?\s*(\d+)/);if(m&&num_(o.total)>=Number(m[1])&&num_(o.total)<=Number(m[2]))earned=Math.max(earned,Number(m[3]));}); if(earned>0)updateRow_('CustomerAccounts','phone',phone,{tokens:num_(acct.tokens)+earned}); } catch(e){}
}
function configureTableCodes_(req,user){
  var count=Math.max(0,Math.min(200,Number(req.count)||0)), enabled=req.enabled!==false;
  var ss=SpreadsheetApp.getActive(), sh=ss.getSheetByName('TableCodes');
  if(!enabled){setSetting_('requireTableCode','false');return {enabled:false,codes:[]};}
  var existing=readTable_('TableCodes'), codes=[];
  for(var i=1;i<=count;i++){
    var old=existing.filter(function(x){return Number(x.tableNo)===i;})[0];
    var code=old && String(old.code||'').length===6 ? String(old.code) : String(Math.floor(100000+Math.random()*900000));
    var row={tableNo:i,code:code,active:true,updatedAt:now_()};
    if(old) updateRow_('TableCodes','tableNo',i,row); else appendRow_('TableCodes',row);
    codes.push({tableNo:i,code:code});
  }
  existing.forEach(function(x){if(Number(x.tableNo)>count) updateRow_('TableCodes','tableNo',Number(x.tableNo),{tableNo:x.tableNo,code:x.code,active:false,updatedAt:now_()});});
  setSetting_('requireTableCode','true'); audit_(user,'tables.codes.generate','Generated/retained '+count+' table codes'); return {enabled:true,codes:codes};
}
function validateTableCode_(req){
  if(String(getSetting_('requireTableCode','false'))!=='true') return {valid:true,required:false};
  var tableNo=Number(req.tableNo), code=String(req.code||'').trim();
  var r=readTable_('TableCodes').filter(function(x){return Number(x.tableNo)===tableNo && toBool_(x.active);})[0];
  return {valid:!!r && String(r.code)===code,required:true};
}
function setWorkday_(req,user){
  var date=Utilities.formatDate(new Date(),TIMEZONE,'yyyy-MM-dd'), ids=Array.isArray(req.userIds)?req.userIds.map(String):[], staff=readTable_('Users').filter(function(u){return toBool_(u.active)&&['waiter','delivery'].indexOf(String(u.role))>=0;}), all=readTable_('Workday').filter(function(w){return String(w.date)===date;});
  staff.forEach(function(u){var old=all.filter(function(w){return String(w.userId)===String(u.id);})[0], available=ids.indexOf(String(u.id))>=0;var row={dateUserId:date+'_'+u.id,date:date,userId:u.id,name:u.name,role:u.role,available:available,tasksCompleted:old?old.tasksCompleted:0,tasksAssigned:old?old.tasksAssigned:0,updatedAt:now_()};if(old)updateRow_('Workday','dateUserId',date+'_'+u.id,row);else appendRow_('Workday',row);});
  audit_(user,'workday.set','Available staff: '+ids.length);return listWorkday_({},user);
}
function listWorkday_(req,user){var date=String(req.date||Utilities.formatDate(new Date(),TIMEZONE,'yyyy-MM-dd'));return readTable_('Workday').filter(function(w){return String(w.date)===date;}).sort(function(a,b){return Number(a.tasksCompleted)-Number(b.tasksCompleted);});}
function monthlyExportData_(req,user){
  var month=String(req.month||Utilities.formatDate(new Date(),TIMEZONE,'yyyy-MM')).slice(0,7), orders=readTable_('Orders').filter(function(o){return String(o.createdAt||'').slice(0,7)===month;}), records=readTable_('FeatureRecords').filter(function(r){return String(r.createdAt||'').slice(0,7)===month;}), staff=readTable_('Users').filter(function(u){return toBool_(u.active);});
  var totals={month:month,orders:orders.length,sales:orders.filter(function(o){return ['Confirmed','Paid','Completed'].indexOf(String(o.paymentStatus))>=0;}).reduce(function(s,o){return s+num_(o.total);},0),completed:orders.filter(function(o){return String(o.status)==='Completed';}).length,pending:orders.filter(function(o){return ['Pending','Awaiting manager verification'].indexOf(String(o.status))>=0;}).length,staff:staff.map(function(u){var mine=orders.filter(function(o){return String(o.assignedToId)===String(u.id)||String(o.completedBy)===String(u.name);});return {name:u.name,role:u.role,orders:mine.length,completed:mine.filter(function(o){return String(o.status)==='Completed';}).length};}),featureCounts:{}};
  records.forEach(function(r){totals.featureCounts[r.type]=(totals.featureCounts[r.type]||0)+1;}); return totals;
}
function exportMonthlyReports_(req,user){
  var month=String(req.month||Utilities.formatDate(new Date(),TIMEZONE,'yyyy-MM')).slice(0,7), summary=monthlyExportData_({month:month},user), orders=readTable_('Orders').filter(function(o){return String(o.createdAt||'').slice(0,7)===month;});
  var currentDate=new Date(month+'-01T00:00:00'); var comparisons=[]; for(var back=1;back<=3;back++){var d=new Date(currentDate.getFullYear(),currentDate.getMonth()-back,1);var mk=Utilities.formatDate(d,TIMEZONE,'yyyy-MM');var mo=readTable_('Orders').filter(function(o){return String(o.createdAt||'').slice(0,7)===mk;});comparisons.push({month:mk,orders:mo.length,sales:mo.filter(function(o){return ['Paid','Confirmed'].indexOf(String(o.paymentStatus))>=0;}).reduce(function(sum,o){return sum+num_(o.total);},0)});}
  var book=SpreadsheetApp.create('Kanyatsi Monthly Analytics '+month), sh=book.getSheets()[0]; sh.setName('Monthly Summary'); sh.appendRow(['Metric','Value']); sh.appendRow(['Month',month]); sh.appendRow(['Orders',summary.orders]); sh.appendRow(['Sales UGX',summary.sales]); sh.appendRow(['Completed orders',summary.completed]); sh.appendRow(['Pending orders',summary.pending]); sh.appendRow([]); sh.appendRow(['Previous months comparison']); sh.appendRow(['Month','Orders','Sales UGX']); comparisons.forEach(function(c){sh.appendRow([c.month,c.orders,c.sales]);}); sh.appendRow([]); sh.appendRow(['Worker','Role','Orders handled','Completed']); summary.staff.forEach(function(w){sh.appendRow([w.name,w.role,w.orders,w.completed]);}); var detail=book.insertSheet('Order Details'); detail.appendRow(['Order ID','Date','Mode','Customer','Phone','Payment Method','Payment Status','Status','Total UGX','Assigned Worker','Completed By']); orders.forEach(function(o){detail.appendRow([o.id,o.createdAt,o.mode,o.customer,o.phone,o.paymentMethod,o.paymentStatus,o.status,num_(o.total),o.assignedToName,o.completedBy]);});
  var slide=SlidesApp.create('Kanyatsi Monthly Performance '+month); var slides=slide.getSlides(); var first=slides[0]; first.insertTextBox('KANYATSI RESTAURANT\nMonthly performance: '+month+'\nSales: UGX '+fmt_(summary.sales)+'\nOrders: '+summary.orders+'\nCompleted: '+summary.completed+'\nPending: '+summary.pending,40,50,620,250); var workerSlide=slide.appendSlide(SlidesApp.PredefinedLayout.TITLE_AND_BODY); workerSlide.getPlaceholder(SlidesApp.PlaceholderType.TITLE).asShape().getText().setText('Staff performance'); var body=workerSlide.getPlaceholder(SlidesApp.PlaceholderType.BODY).asShape().getText(); summary.staff.forEach(function(w){body.appendParagraph(w.name+' ('+w.role+'): '+w.completed+' completed / '+w.orders+' handled');});
  // Export a genuine XLSX copy through the authenticated Google Drive export endpoint.
  var url='https://docs.google.com/spreadsheets/d/'+book.getId()+'/export?format=xlsx'; var response=UrlFetchApp.fetch(url,{headers:{Authorization:'Bearer '+ScriptApp.getOAuthToken()},muteHttpExceptions:true}); if(response.getResponseCode()<200||response.getResponseCode()>=300) throw new Error('Report spreadsheet created but XLSX export failed. Check Drive/UrlFetch permissions.'); var xlsx=DriveApp.createFile(response.getBlob().setName('Kanyatsi Monthly Analytics '+month+'.xlsx')); var pptxResponse=UrlFetchApp.fetch('https://docs.google.com/presentation/d/'+slide.getId()+'/export/pptx',{headers:{Authorization:'Bearer '+ScriptApp.getOAuthToken()},muteHttpExceptions:true}); if(pptxResponse.getResponseCode()<200||pptxResponse.getResponseCode()>=300) throw new Error('Excel export succeeded but PowerPoint export failed. Open the generated Google Slides report.'); var pptx=DriveApp.createFile(pptxResponse.getBlob().setName('Kanyatsi Monthly Performance '+month+'.pptx')); // Keep analytics files private in the owner's Drive because order details include customer phone numbers. audit_(user,'Monthly report exported',month); return {month:month,excelUrl:xlsx.getUrl(),powerPointUrl:pptx.getUrl(),slidesUrl:'https://docs.google.com/presentation/d/'+slide.getId()+'/edit',spreadsheetUrl:book.getUrl(),comparisons:comparisons};
}
function customerRegister_(req){
  var phone=String(req.phone||'').replace(/[^0-9]/g,'');var name=String(req.name||'').trim(),pw=String(req.password||'');if(phone.length<9||!name||pw.length<6)throw new Error('Enter your name, valid phone number and password of at least 6 characters.');
  var old=readTable_('CustomerAccounts').filter(function(x){return String(x.phone)===phone;})[0];if(old)throw new Error('An account already exists for this phone number.');var salt=Utilities.getUuid(),row={id:readTable_('CustomerAccounts').length+1,phone:phone,name:name,salt:salt,passHash:hashPassword_(salt,pw),pictureUrl:String(req.pictureUrl||''),walletBalance:0,tokens:0,createdAt:now_(),active:true};appendRow_('CustomerAccounts',row);return {phone:phone,name:name,pictureUrl:row.pictureUrl,walletBalance:0,tokens:0};
}
function customerLogin_(req){var phone=String(req.phone||'').replace(/[^0-9]/g,''),pw=String(req.password||''),u=readTable_('CustomerAccounts').filter(function(x){return String(x.phone)===phone&&toBool_(x.active);})[0];if(!u||hashPassword_(u.salt,pw)!==String(u.passHash))throw new Error('Invalid phone number or password.');return {phone:u.phone,name:u.name,pictureUrl:u.pictureUrl,walletBalance:num_(u.walletBalance),tokens:num_(u.tokens)};}
function authenticateCustomer_(req){var phone=String(req.phone||'').replace(/[^0-9]/g,''),pw=String(req.password||''),u=readTable_('CustomerAccounts').filter(function(x){return String(x.phone)===phone&&toBool_(x.active);})[0];if(!u||hashPassword_(u.salt,pw)!==String(u.passHash))throw new Error('Sign in again with your customer phone and password.');return u;}
function customerProfile_(req){var u=authenticateCustomer_(req);return {phone:u.phone,name:u.name,pictureUrl:u.pictureUrl,walletBalance:num_(u.walletBalance),tokens:num_(u.tokens)};}
function customerHistory_(req){var u=authenticateCustomer_(req), phone=String(u.phone);return readTable_('Orders').filter(function(o){return String(o.phone||'').replace(/[^0-9]/g,'')===phone;}).sort(function(a,b){return String(b.createdAt).localeCompare(String(a.createdAt));}).slice(0,300).map(function(o){return orderView_(o,itemsByOrder_(),true);});}



// ---------------------------------------------------------------- first setup

function setupSheets() {
  var ss = SpreadsheetApp.getActive();
  Object.keys(SHEETS).forEach(function (name) {
    var s = ss.getSheetByName(name) || ss.insertSheet(name);
    var headers = SHEETS[name];
    s.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    s.setFrozenRows(1);
    (TEXT_COLUMNS[name] || []).forEach(function (h) {
      s.getRange(2, headers.indexOf(h) + 1, s.getMaxRows() - 1, 1).setNumberFormat('@');
    });
  });
  var blank = ss.getSheetByName('Sheet1');
  if (blank && ss.getSheets().length > 1 && blank.getLastRow() === 0) ss.deleteSheet(blank);

  // Touch Drive and Mail once so Google asks for those permissions now.
  var folders = DriveApp.getFoldersByName(IMAGE_FOLDER);
  if (!folders.hasNext()) DriveApp.createFolder(IMAGE_FOLDER);
  MailApp.getRemainingDailyQuota();
  // Authorize Slides and outbound HTTPS once so the monthly report export can run as the owner.
  var tempSlides = SlidesApp.create('Kanyatsi temporary authorization check');
  DriveApp.getFileById(tempSlides.getId()).setTrashed(true);
  UrlFetchApp.fetch('https://www.google.com/generate_204', { muteHttpExceptions: true });

  if (readTable_('Menu').length === 0) {
    [
      ['Chicken Pilawo', 'Local Food', 15000, 'Spiced rice with chicken and vegetables.'],
      ['Beef Pilawo', 'Local Food', 14000, 'Pilawo rice served with tender beef.'],
      ['Katogo', 'Breakfast', 10000, 'Traditional breakfast with fresh ingredients.'],
      ['Chapati', 'Snacks', 3000, 'Freshly prepared chapati.'],
      ['Pizza', 'Pizza', 22000, 'Restaurant house pizza.'],
      ['Coffee', 'Coffee', 5000, 'Hot freshly prepared coffee.'],
      ['Soda', 'Beverages', 3000, 'Chilled soft drink.'],
      ['Fresh Juice', 'Beverages', 6000, 'Fresh seasonal fruit juice.']
    ].forEach(function (m, i) {
      appendRow_('Menu', { id: i + 1, name: m[0], category: m[1], price: m[2],
                           description: m[3], available: true, imageUrl: '' });
    });
  }
  if (readTable_('Combos').length === 0) {
    appendRow_('Combos', { id: 1, name: 'Pilawo & Soda', description: 'Chicken Pilawo with a chilled soda.',
                           price: 17000, available: true, imageUrl: '',
                           itemsJson: JSON.stringify([{ id: 1, qty: 1 }, { id: 7, qty: 1 }]) });
  }
  if (readTable_('Stations').length === 0) {
    appendRow_('Stations', { id: 1, name: 'Kagando Trading Centre', fee: 2000 });
    appendRow_('Stations', { id: 2, name: 'Health Centre Junction', fee: 3000 });
  }
  if (!findRow_('Settings', 'key', 'tableCount')) setSetting_('tableCount', 10);
  if (readTable_('Inventory').length === 0) {
    [['Rice', 'kg', 18, 10], ['Chicken', 'kg', 7, 8], ['Beef', 'kg', 12, 5],
     ['Cooking Oil', 'litres', 4, 5], ['Soda', 'crates', 9, 3]
    ].forEach(function (x, i) {
      appendRow_('Inventory', { id: i + 1, name: x[0], unit: x[1], stock: x[2], minimum: x[3] });
    });
  }
  if (readTable_('Users').length === 0) {
    var salt = Utilities.getUuid();
    appendRow_('Users', { id: 1, name: 'Administrator', username: 'admin', email: '', role: 'admin',
                          salt: salt, passHash: hashPassword_(salt, 'Admin@1234'),
                          active: true, mustChange: true });
  }
  Logger.log('Setup complete. First login: admin / Admin@1234 (you must change it).');
}
