const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const QRCode = require('qrcode');
const session = require('express-session');

const app = express();
const DATA_FILE = path.join(__dirname, 'data', 'jobsite_data.json');

require('dotenv').config();

// ==========================================
// MIDDLEWARE SETUP
// ==========================================

app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Session Configuration
app.use(session({
  secret: process.env.SESSION_SECRET || 'fallback-secret-key-change-this-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 1000 * 60 * 60 * 48, // 48 hours
    httpOnly: true,  // Prevents client-side JS from accessing the cookie
    secure: process.env.NODE_ENV === 'production' // Only send over HTTPS in production
  }
}));

// ==========================================
// AUTHENTICATION MIDDLEWARE
// ==========================================

function requireAuth(req, res, next) {
  if (req.session && req.session.isAdmin === true) {
    return next();
  }
  res.redirect('/admin/login');
}

// ==========================================
// HELPER FUNCTIONS
// ==========================================

function getData() {
  if (!fs.existsSync(DATA_FILE)) {
    const dir = path.dirname(DATA_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify({ houses: [] }, null, 2));
  }
  const rawData = fs.readFileSync(DATA_FILE);
  const parsed = JSON.parse(rawData);
  if (!parsed.houses) parsed.houses = [];
  return parsed;
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function findRoomAndHouseById(data, roomId) {
  if (!data.houses || data.houses.length === 0) {
    return { room: null, house: null };
  }

  for (const house of data.houses) {
    if (house.rooms) {
      const room = house.rooms.find(r => r.id === roomId);
      if (room) {
        return { room, house };
      }
    }
  }

  for (const house of data.houses) {
    if (roomId.startsWith(house.id)) {
      const room = house.rooms ? house.rooms.find(r => r.id === roomId) : null;
      if (room) {
        return { room, house };
      }
    }
  }

  return { room: null, house: null };
}

function findRoomById(data, roomId) {
  const { room } = findRoomAndHouseById(data, roomId);
  return room;
}

// Helper: Delete physical file from disk using web URL
function deleteFileFromDisk(webUrl) {
  if (!webUrl || typeof webUrl !== 'string') return;
  const relativePath = webUrl.startsWith('/') ? webUrl.substring(1) : webUrl;
  const filePath = path.join(__dirname, 'public', relativePath);

  if (fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath);
    } catch (err) {
      console.error(`Failed to delete file from disk: ${filePath}`, err);
    }
  }
}

// ==========================================
// FILE UPLOAD CONFIGURATION
// ==========================================

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const data = getData();
    const { roomId } = req.params;
    const { room, house } = findRoomAndHouseById(data, roomId);

    const houseFolder = house ? house.id : 'unassigned';
    const roomFolder = room ? room.id : roomId;

    const uploadDir = path.join(__dirname, 'public', 'uploads', houseFolder, roomFolder);

    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});
const upload = multer({ storage });

// ==========================================
// AUTH ROUTES (Unprotected)
// ==========================================

app.get('/admin/login', (req, res) => {
  if (req.session && req.session.isAdmin) {
    return res.redirect('/admin');
  }
  res.render('login', { error: null });
});

app.post('/admin/login', (req, res) => {
  const { username, password } = req.body;

  const ADMIN_USER = process.env.ADMIN_USER;
  const ADMIN_PASS = process.env.ADMIN_PASS;

  // Check if credentials exist in environment
  if (!ADMIN_USER || !ADMIN_PASS) {
    console.error('ERROR: ADMIN_USER or ADMIN_PASS not set in environment variables');
    return res.render('login', { error: 'System configuration error. Please contact administrator.' });
  }

  if (username === ADMIN_USER && password === ADMIN_PASS) {
    req.session.isAdmin = true;
    req.session.save((err) => {
      if (err) {
        console.error('Session save error:', err);
        return res.render('login', { error: 'Login failed. Please try again.' });
      }
      return res.redirect('/admin');
    });
  } else {
    return res.render('login', { error: 'Invalid username or password.' });
  }
});

app.get('/admin/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) {
      console.error('Logout error:', err);
    }
    res.redirect('/admin/login');
  });
});

// ==========================================
// PROTECTED ADMIN ROUTES
// ==========================================

// Apply authentication middleware to ALL /admin routes EXCEPT login
app.use('/admin', (req, res, next) => {
  // Skip auth for login routes
  if (req.path === '/login' || req.path === '/login/' || (req.method === 'POST' && req.path === '/login')) {
    return next();
  }
  requireAuth(req, res, next);
});

// 1. Admin Dashboard
app.get('/admin', (req, res) => {
  const data = getData();
  res.render('admin', { houses: data.houses || [] });
});

// 2. Create House
app.post('/admin/houses', (req, res) => {
  const data = getData();
  const houseName = req.body.houseName;
  const newHouse = {
    id: houseName.toLowerCase().trim().replace(/[^a-z0-9]/g, '-'),
    name: houseName,
    rooms: []
  };

  data.houses.push(newHouse);
  saveData(data);
  res.redirect('/admin');
});

// 3. Create Room
app.post('/admin/houses/:houseId/rooms', (req, res) => {
  const data = getData();
  const house = data.houses.find(h => h.id === req.params.houseId);

  if (house) {
    const roomName = req.body.roomName;
    const newRoom = {
      id: `${house.id}-${roomName.toLowerCase().trim().replace(/[^a-z0-9]/g, '-')}`,
      name: roomName,
      status: 'draft',
      trades: [
        { id: 'electrical', name: 'Electrical', renderUrl: '', planUrl: '', notes: '' },
        { id: 'plumbing', name: 'Plumbing', renderUrl: '', planUrl: '', notes: '' },
        { id: 'hvac', name: 'HVAC', renderUrl: '', planUrl: '', notes: '' }
      ],
      comments: []
    };
    if (!house.rooms) house.rooms = [];
    house.rooms.push(newRoom);
    saveData(data);
    res.redirect(`/admin/edit/${newRoom.id}`);
  } else {
    res.status(404).send('House not found');
  }
});

// 4. Edit Room Interface
app.get('/admin/edit/:id', (req, res) => {
  const data = getData();
  const room = findRoomById(data, req.params.id);

  if (!room) return res.status(404).send('Room not found');
  const selectedTrade = req.query.trade || (room.trades[0] ? room.trades[0].id : '');

  res.render('admin-edit', { room, selectedTrade });
});

// 5. Save Room Trade Details
app.post('/admin/edit/:roomId/save', upload.fields([
  { name: 'render', maxCount: 1 },
  { name: 'plan', maxCount: 1 }
]), (req, res) => {
  const data = getData();
  const { roomId } = req.params;
  const { tradeId, notes } = req.body;

  const { room, house } = findRoomAndHouseById(data, roomId);
  if (!room) return res.status(404).send('Room not found');

  const trade = room.trades.find(t => t.id === tradeId);
  if (!trade) return res.status(404).send('Trade tab not found');

  trade.notes = notes || '';

  const houseFolder = house ? house.id : 'unassigned';

  if (req.files) {
    if (req.files.render && req.files.render[0]) {
      if (trade.renderUrl) deleteFileFromDisk(trade.renderUrl);
      trade.renderUrl = `/uploads/${houseFolder}/${room.id}/${req.files.render[0].filename}`;
    }

    if (req.files.plan && req.files.plan[0]) {
      if (trade.planUrl) deleteFileFromDisk(trade.planUrl);
      trade.planUrl = `/uploads/${houseFolder}/${room.id}/${req.files.plan[0].filename}`;
    }
  }

  saveData(data);
  res.redirect(`/admin/edit/${roomId}?trade=${tradeId}`);
});

// 6. Add Trade Tab
app.post('/admin/edit/:roomId/add-trade', (req, res) => {
  const data = getData();
  const { roomId } = req.params;
  const { tradeName } = req.body;

  const room = findRoomById(data, roomId);
  if (room) {
    const tradeId = tradeName.toLowerCase().trim().replace(/[^a-z0-9]/g, '-');
    const existingTrade = room.trades.find(t => t.id === tradeId);

    if (!existingTrade) {
      room.trades.push({
        id: tradeId,
        name: tradeName,
        renderUrl: '',
        planUrl: '',
        notes: ''
      });
      saveData(data);
    }
    return res.redirect(`/admin/edit/${roomId}?trade=${tradeId}`);
  }

  res.status(404).send('Room not found');
});

// 7. Delete Trade Tab
app.post('/admin/edit/:roomId/delete-trade/:tradeId', (req, res) => {
  const data = getData();
  const room = findRoomById(data, req.params.roomId);

  if (room) {
    const tradeToDelete = room.trades.find(t => t.id === req.params.tradeId);
    if (tradeToDelete) {
      if (tradeToDelete.renderUrl) deleteFileFromDisk(tradeToDelete.renderUrl);
      if (tradeToDelete.planUrl) deleteFileFromDisk(tradeToDelete.planUrl);
    }

    room.trades = room.trades.filter(t => t.id !== req.params.tradeId);
    saveData(data);
    return res.redirect(`/admin/edit/${room.id}`);
  }
  res.status(404).send('Room not found');
});

// 8. Toggle Room Publish / Draft Status
app.post('/admin/toggle-publish/:id', (req, res) => {
  const data = getData();
  const room = findRoomById(data, req.params.id);

  if (room) {
    room.status = room.status === 'published' ? 'draft' : 'published';
    saveData(data);
  }

  res.redirect(`/admin/edit/${req.params.id}`);
});

// ==========================================
// PUBLIC VIEW ROUTES (Unprotected)
// ==========================================

app.get('/house/:id', (req, res) => {
  const data = getData();
  const house = data.houses.find(h => h.id === req.params.id);

  if (!house) return res.status(404).send('House project not found');

  res.render('house', { house, rooms: house.rooms || [] });
});

app.get('/room/:id', async (req, res) => {
  const data = getData();
  const { room, house } = findRoomAndHouseById(data, req.params.id);

  if (!room) return res.status(404).send('Room specifications not found');

  const roomUrl = `${req.protocol}://${req.get('host')}/room/${room.id}`;
  const qrCodeUrl = await QRCode.toDataURL(roomUrl);
  const activeTrade = req.query.trade || (room.trades[0] ? room.trades[0].id : '');

  res.render('room', {
    room,
    house: house || null,
    activeTrade,
    qrCodeUrl,
    roomUrl
  });
});

app.post('/room/:id/comment', (req, res) => {
  const data = getData();
  const room = findRoomById(data, req.params.id);

  if (room) {
    const newComment = {
      author: req.body.author || 'Anonymous Trade',
      text: req.body.text,
      timestamp: new Date().toISOString().replace('T', ' ').substring(0, 16)
    };
    if (!room.comments) room.comments = [];
    room.comments.unshift(newComment);
    saveData(data);
  }

  res.redirect(`/room/${req.params.id}?trade=${req.body.activeTrade}`);
});

// 404 handler
app.use((req, res) => {
  res.status(404).render('404');
});

// ==========================================
// START SERVER
// ==========================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Admin panel: http://localhost:${PORT}/admin`);
});