const express = require('express');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const multer = require('multer');
const QRCode = require('qrcode');
const { createCanvas, loadImage, registerFont } = require('canvas');
const session = require('express-session');
const nodemailer = require('nodemailer');
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

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_APP_PASSWORD
  }
});

// ==========================================
// AUTHENTICATION MIDDLEWARE
// ==========================================

// Session Configuration
app.use(session({
  secret: process.env.SESSION_SECRET || 'fallback-secret-key-change-this-in-production',
  resave: true,
  saveUninitialized: false,
  cookie: {
    maxAge: 1000 * 60 * 60 * 48, // 48 Hours
    httpOnly: true,
    // Set secure to true ONLY when running under HTTPS in production
    secure: process.env.NODE_ENV === 'production' && process.env.HTTPS === 'true',
    sameSite: 'lax'
  }
}));

// Global Session Interceptor
app.use((req, res, next) => {
  const originalRedirect = res.redirect;
  res.redirect = function (url) {
    if (req.session) {
      req.session.save((err) => {
        if (err) console.error('Session save error during redirect:', err);
        originalRedirect.call(this, url);
      });
    } else {
      originalRedirect.call(this, url);
    }
  };
  next();
});

app.use((req, res, next) => {
  res.locals.baseUrl = `${req.protocol}://${req.get('host')}`;
  res.locals.currentPath = req.path;
  res.locals.isAdmin = req.session && req.session.isAdmin === true;
  next();
});

function requireAuth(req, res, next) {
  if (req.session && req.session.isAdmin === true) {
    return next();
  }

  // Handle AJAX / JSON authentication failures gracefully
  if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Redirect to login WITHOUT destroying the session store
  res.redirect('/admin/login');
}

// ==========================================
// HELPER FUNCTIONS
// ==========================================

function getData() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      const dir = path.dirname(DATA_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const defaultData = { houses: [] };
      fs.writeFileSync(DATA_FILE, JSON.stringify(defaultData, null, 2));
      return defaultData;
    }
    const rawData = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(rawData);
    if (!parsed.houses) parsed.houses = [];
    return parsed;
  } catch (err) {
    console.error('Error reading data:', err);
    return { houses: [] };
  }
}

function saveData(data) {
  try {
    if (!data || typeof data !== 'object') {
      throw new Error('Invalid data object');
    }
    if (!data.houses) data.houses = [];

    // Atomic file write using temporary file
    const tempFile = DATA_FILE + '.tmp';
    fs.writeFileSync(tempFile, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tempFile, DATA_FILE);
    return true;
  } catch (err) {
    console.error('Error saving data:', err);
    throw err;
  }
}

function findRoomAndHouseById(data, roomId) {
  // Safety check: handle null, undefined, or non-string inputs
  if (!roomId || typeof roomId !== 'string') {
    return { room: null, house: null };
  }

  // Your existing search logic...
  for (const house of data.houses || []) {
    if (roomId.startsWith(house.id)) { // Now safe from crashing!
      const room = house.rooms.find(r => r.id === roomId);
      if (room) return { room, house };
    }
  }

  return { room: null, house: null };
}

function findRoomById(data, roomId) {
  const { room } = findRoomAndHouseById(data, roomId);
  return room;
}

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

function deleteRoomFiles(roomId) {
  try {
    const data = getData();
    const { room, house } = findRoomAndHouseById(data, roomId);

    if (room && house) {
      room.trades.forEach(trade => {
        if (trade.renderUrl) deleteFileFromDisk(trade.renderUrl);
        if (trade.planUrl) deleteFileFromDisk(trade.planUrl);
        if (trade.images && trade.images.length > 0) {
          trade.images.forEach(image => {
            deleteFileFromDisk(image.url);
          });
        }
        if (trade.files && trade.files.length > 0) {
          trade.files.forEach(file => {
            deleteFileFromDisk(file.url);
          });
        }
        if (trade.comments && trade.comments.length > 0) {
          trade.comments.forEach(comment => {
            if (comment.attachments && comment.attachments.length > 0) {
              comment.attachments.forEach(attachment => {
                deleteFileFromDisk(attachment.url);
              });
            }
          });
        }
      });
    }
  } catch (err) {
    console.error('Error deleting room files:', err);
  }
}

// ==========================================
// FILE UPLOAD CONFIGURATION
// ==========================================

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 1024 * 1024 * 1024 // 1GB limit
  }
});

function getFileType(mimetype) {
  if (mimetype.startsWith('image/')) return 'image';
  if (mimetype === 'application/pdf') return 'pdf';
  if (mimetype.startsWith('application/') || mimetype.startsWith('text/')) return 'document';
  return 'other';
}

async function saveUploadedFile(file, houseFolder, roomFolder) {
  const dir = path.join(__dirname, 'public', 'uploads', houseFolder, roomFolder);
  fs.mkdirSync(dir, { recursive: true });

  const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);

  if (file.mimetype.startsWith('image/')) {
    const filename = uniqueSuffix + '.jpg';
    await sharp(file.buffer)
      .resize({ width: 1920, withoutEnlargement: true })
      .jpeg({ quality: 75 })
      .toFile(path.join(dir, filename));
    return { filename, mimetype: 'image/jpeg' };
  } else {
    const filename = uniqueSuffix + path.extname(file.originalname);
    fs.writeFileSync(path.join(dir, filename), file.buffer);
    return { filename, mimetype: file.mimetype };
  }
}

// ==========================================
// AUTH ROUTES
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

// ======================
// PROTECTED ADMIN ROUTE 
// ======================

app.use('/admin', requireAuth);

// Admin Dashboard
app.get('/admin', (req, res) => {
  try {
    const data = getData();
    res.render('admin', { houses: data.houses || [] });
  } catch (err) {
    console.error('Dashboard error:', err);
    res.status(500).send('Error loading dashboard');
  }
});

// Create House
app.post('/admin/houses', (req, res) => {
  try {
    const data = getData();
    const houseName = req.body.houseName;
    const newHouse = {
      id: houseName.toLowerCase().trim().replace(/[^a-z0-9]/g, '-'),
      name: houseName,
      rooms: []
    };

    data.houses.push(newHouse);
    saveData(data);

    req.session.save((err) => {
      if (err) console.error('Session save error:', err);
      res.redirect('/admin');
    });
  } catch (err) {
    console.error('Error creating house:', err);
    res.status(500).send('Error creating house');
  }
});

// Rename House
app.post('/admin/houses/:houseId/rename', (req, res) => {
  try {
    const data = getData();
    const house = data.houses.find(h => h.id === req.params.houseId);

    if (house) {
      house.name = req.body.newName.trim();
      saveData(data);

      if (req.is('json') || req.xhr) {
        return res.json({ success: true, name: house.name });
      }

      req.session.save((err) => {
        if (err) console.error('Session save error:', err);
        res.redirect('/admin');
      });
    } else {
      res.status(404).send('House not found');
    }
  } catch (error) {
    console.error('Error renaming house:', error);
    res.status(500).send('Error renaming house');
  }
});

// Delete House
app.post('/admin/houses/:houseId/delete', (req, res) => {
  try {
    const data = getData();
    const houseToDelete = data.houses.find(h => h.id === req.params.houseId);

    if (houseToDelete) {
      houseToDelete.rooms.forEach(room => {
        deleteRoomFiles(room.id);
      });

      const houseFolder = path.join(__dirname, 'public', 'uploads', houseToDelete.id);
      if (fs.existsSync(houseFolder)) {
        fs.rmSync(houseFolder, { recursive: true, force: true });
      }
    }

    data.houses = data.houses.filter(h => h.id !== req.params.houseId);
    saveData(data);

    req.session.save((err) => {
      if (err) console.error('Session save error:', err);
      res.redirect('/admin');
    });
  } catch (err) {
    console.error('Error deleting house:', err);
    res.status(500).send('Error deleting house');
  }
});

// Reorder houses
app.post('/admin/houses/reorder', (req, res) => {
  try {
    const data = getData();
    const { houseOrder } = req.body;

    if (!houseOrder || !Array.isArray(houseOrder)) {
      return res.status(400).json({ error: 'Invalid house order' });
    }

    // Sort houses based on the new order
    data.houses.sort((a, b) => houseOrder.indexOf(a.id) - houseOrder.indexOf(b.id));
    saveData(data);
    res.json({ success: true });
  } catch (err) {
    console.error('Error reordering houses:', err);
    res.status(500).json({ error: 'Failed to reorder houses' });
  }
});

// Create Room
app.post('/admin/houses/:houseId/rooms', (req, res) => {
  try {
    const data = getData();
    const house = data.houses.find(h => h.id === req.params.houseId);

    if (house) {
      const roomName = req.body.roomName;
      const newRoom = {
        id: `${house.id}-${roomName.toLowerCase().trim().replace(/[^a-z0-9]/g, '-')}`,
        name: roomName,
        status: 'draft',
        trades: [
          { id: 'general-' + Date.now(), name: 'General', renderUrl: '', planUrl: '', notes: '', images: [], files: [], comments: [] },
          { id: 'electrical-' + Date.now(), name: 'Electrical', renderUrl: '', planUrl: '', notes: '', images: [], files: [], comments: [] },
          { id: 'plumbing-' + Date.now(), name: 'Plumbing', renderUrl: '', planUrl: '', notes: '', images: [], files: [], comments: [] },
          { id: 'hvac-' + Date.now(), name: 'HVAC', renderUrl: '', planUrl: '', notes: '', images: [], files: [], comments: [] }
        ]
      };
      if (!house.rooms) house.rooms = [];
      house.rooms.push(newRoom);
      saveData(data);

      req.session.save((err) => {
        if (err) console.error('Session save error:', err);
        res.redirect('/admin');
      });
    } else {
      res.status(404).send('House not found');
    }
  } catch (err) {
    console.error('Error creating room:', err);
    res.status(500).send('Error creating room');
  }
});

// Rename Room
app.post('/admin/rooms/:roomId/rename', (req, res) => {
  try {
    const data = getData();
    const room = findRoomById(data, req.params.roomId);

    if (room) {
      room.name = req.body.newName.trim();
      saveData(data);

      if (req.is('json') || req.xhr) {
        return res.json({ success: true, name: room.name });
      }

      req.session.save((err) => {
        if (err) console.error('Session save error:', err);
        res.redirect('/admin');
      });
    } else {
      res.status(404).send('Room not found');
    }
  } catch (error) {
    console.error('Error renaming room:', error);
    res.status(500).send('Error renaming room');
  }
});

// Delete Room
app.post('/admin/rooms/:roomId/delete', (req, res) => {
  try {
    const data = getData();
    const roomId = req.params.roomId;

    let roomFound = false;
    let houseId = null;

    data.houses.forEach((house) => {
      const initialLength = house.rooms.length;
      house.rooms = house.rooms.filter((room) => room.id !== roomId);

      if (house.rooms.length < initialLength) {
        roomFound = true;
        houseId = house.id;
      }
    });

    if (roomFound) {
      deleteRoomFiles(roomId);
      if (houseId) {
        const roomFolder = path.join(__dirname, 'public', 'uploads', houseId, roomId);
        if (fs.existsSync(roomFolder)) {
          fs.rmSync(roomFolder, { recursive: true, force: true });
        }
      }

      saveData(data);

      req.session.save((err) => {
        if (err) console.error('Session save error:', err);
        res.redirect('/admin');
      });
    } else {
      res.status(404).send('Room not found');
    }
  } catch (error) {
    console.error('Error deleting room:', error);
    res.status(500).send('Error deleting room');
  }
});

// Edit Room
app.get('/admin/edit/:roomId', (req, res) => {
  const { roomId } = req.params;
  const data = getData();
  const { room } = findRoomAndHouseById(data, roomId);

  if (!room) return res.status(404).send('Room not found');

  room.trades.forEach(t => {
    if (!t.comments) t.comments = [];
    if (!t.files) t.files = [];
  });

  const selectedTrade = req.query.trade || (room.trades[0] ? room.trades[0].id : null);

  res.render('admin-edit-room', {
    room,
    selectedTrade
  });
});

// Add Trade Tab
app.post('/admin/edit/:roomId/add-trade', (req, res) => {
  try {
    const data = getData();
    const { roomId } = req.params;
    const { tradeName } = req.body;

    const room = findRoomById(data, roomId);
    if (room) {
      const tradeId = tradeName.toLowerCase().trim().replace(/[^a-z0-9]/g, '-') + '-' + Date.now();
      const existingTrade = room.trades.find(t => t.id === tradeId);

      if (!existingTrade) {
        room.trades.push({
          id: tradeId,
          name: tradeName,
          renderUrl: '',
          planUrl: '',
          notes: '',
          images: [],
          files: [],
          comments: []
        });
        saveData(data);
      }

      if (req.is('json') || req.xhr) {
        return res.json({ success: true, tradeId: tradeId, tradeName: tradeName });
      }

      req.session.save((err) => {
        if (err) console.error('Session save error:', err);
        res.redirect(`/admin/edit/${roomId}?trade=${tradeId}`);
      });
    } else {
      res.status(404).send('Room not found');
    }
  } catch (err) {
    console.error('Error adding trade:', err);
    res.status(500).send('Error adding trade');
  }
});

// Rename Trade
app.post('/admin/edit/:roomId/rename-trade/:tradeId', (req, res) => {
  try {
    const data = getData();
    const { roomId, tradeId } = req.params;
    const { newName } = req.body;

    const room = findRoomById(data, roomId);
    if (room) {
      const trade = room.trades.find(t => t.id === tradeId);
      if (trade) {
        trade.name = newName.trim();
        saveData(data);

        // NEW: return JSON for AJAX callers instead of always redirecting
        if (req.is('json') || req.xhr) {
          return res.json({ success: true, name: trade.name });
        }

        req.session.save((err) => {
          if (err) console.error('Session save error:', err);
          res.redirect(`/admin/edit/${roomId}?trade=${tradeId}`);
        });
      } else {
        res.status(404).send('Trade not found');
      }
    } else {
      res.status(404).send('Room not found');
    }
  } catch (error) {
    console.error('Error renaming trade:', error);
    res.status(500).send('Error renaming trade');
  }
});

// Save Trade
app.post('/admin/edit/:roomId/save', upload.fields([
  { name: 'render', maxCount: 1 },
  { name: 'plan', maxCount: 1 },
  { name: 'images', maxCount: 20 },
  { name: 'files', maxCount: 20 }
]), async (req, res) => {
  try {
    const data = getData();
    const { roomId } = req.params;
    const { tradeId, notes } = req.body;

    const { room, house } = findRoomAndHouseById(data, roomId);
    if (!room) return res.status(404).send('Room not found');

    const trade = room.trades.find(t => t.id === tradeId);
    if (!trade) return res.status(404).send('Trade tab not found');

    trade.notes = notes || '';

    if (!trade.images) trade.images = [];
    if (!trade.files) trade.files = [];

    const houseFolder = house ? house.id : 'unassigned';

    if (req.files) {
      if (req.files.render && req.files.render[0]) {
        if (trade.renderUrl) deleteFileFromDisk(trade.renderUrl);
        const saved = await saveUploadedFile(req.files.render[0], houseFolder, room.id);
        trade.renderUrl = `/uploads/${houseFolder}/${room.id}/${saved.filename}`;
      }

      if (req.files.plan && req.files.plan[0]) {
        if (trade.planUrl) deleteFileFromDisk(trade.planUrl);
        const saved = await saveUploadedFile(req.files.plan[0], houseFolder, room.id);
        trade.planUrl = `/uploads/${houseFolder}/${room.id}/${saved.filename}`;
      }

      if (req.files.images && req.files.images.length > 0) {
        for (const file of req.files.images) {
          const saved = await saveUploadedFile(file, houseFolder, room.id);
          trade.images.push({
            url: `/uploads/${houseFolder}/${room.id}/${saved.filename}`,
            originalName: file.originalname,
            filename: saved.filename,
            type: 'image',
            mimetype: saved.mimetype,
            size: fs.statSync(path.join(__dirname, 'public', 'uploads', houseFolder, room.id, saved.filename)).size,
            uploadedAt: new Date().toISOString()
          });
        }
      }

      if (req.files.files && req.files.files.length > 0) {
        for (const file of req.files.files) {
          const saved = await saveUploadedFile(file, houseFolder, room.id);
          trade.files.push({
            url: `/uploads/${houseFolder}/${room.id}/${saved.filename}`,
            originalName: file.originalname,
            filename: saved.filename,
            type: getFileType(saved.mimetype),
            mimetype: saved.mimetype,
            size: fs.statSync(path.join(__dirname, 'public', 'uploads', houseFolder, room.id, saved.filename)).size,
            uploadedAt: new Date().toISOString()
          });
        }
      }
    }

    saveData(data);
    req.session.save((err) => {
      if (err) console.error('Session save error:', err);
      res.redirect(`/admin/edit/${roomId}?trade=${tradeId}`);
    });
  } catch (err) {
    console.error('Error saving trade:', err);
    res.status(500).send('Error saving trade details');
  }
});

// Delete Trade
app.post('/admin/edit/:roomId/delete-trade/:tradeId', (req, res) => {
  try {
    const data = getData();
    const room = findRoomById(data, req.params.roomId);

    if (room) {
      const tradeToDelete = room.trades.find(t => t.id === req.params.tradeId);
      if (tradeToDelete) {
        if (tradeToDelete.renderUrl) deleteFileFromDisk(tradeToDelete.renderUrl);
        if (tradeToDelete.planUrl) deleteFileFromDisk(tradeToDelete.planUrl);

        if (tradeToDelete.images && tradeToDelete.images.length > 0) {
          tradeToDelete.images.forEach(image => {
            deleteFileFromDisk(image.url);
          });
        }

        if (tradeToDelete.files && tradeToDelete.files.length > 0) {
          tradeToDelete.files.forEach(file => {
            deleteFileFromDisk(file.url);
          });
        }
      }

      room.trades = room.trades.filter(t => t.id !== req.params.tradeId);
      saveData(data);

      req.session.save((err) => {
        if (err) console.error('Session save error:', err);
        res.redirect(`/admin/edit/${room.id}`);
      });
    } else {
      res.status(404).send('Room not found');
    }
  } catch (err) {
    console.error('Error deleting trade:', err);
    res.status(500).send('Error deleting trade');
  }
});

// Reorder Trades
app.post('/admin/rooms/:roomId/reorder-trades', (req, res) => {
  try {
    const data = getData();
    const { room } = findRoomAndHouseById(data, req.params.roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });

    const { tradeOrder } = req.body;
    // Sort trades based on the new order by ID
    room.trades.sort((a, b) => tradeOrder.indexOf(a.id) - tradeOrder.indexOf(b.id));
    saveData(data);
    res.json({ success: true });
  } catch (err) {
    console.error('Error reordering trades:', err);
    res.status(500).json({ error: 'Failed to reorder trades' });
  }
});

// Rename Trade
app.post('/admin/rooms/:roomId/rename-trade/:tradeId', (req, res) => {
  try {
    const data = getData();
    const { room } = findRoomAndHouseById(data, req.params.roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });

    const trade = room.trades.find(t => t.id === req.params.tradeId);
    if (!trade) return res.status(404).json({ error: 'Trade not found' });

    const newName = req.body.newName.trim();
    if (!newName) return res.status(400).json({ error: 'Name is required' });

    trade.name = newName;
    saveData(data);
    res.json({ success: true, newName: newName });
  } catch (err) {
    console.error('Error renaming trade:', err);
    res.status(500).json({ error: 'Failed to rename trade' });
  }
});

// Delete comment
app.post('/admin/rooms/:roomId/trades/:tradeId/comments/:commentIndex/delete', (req, res) => {
  try {
    const data = getData();
    const { roomId, tradeId, commentIndex } = req.params;
    const { room } = findRoomAndHouseById(data, roomId);

    if (!room) return res.status(404).send('Room not found');

    const trade = room.trades.find(t => t.id === tradeId);
    if (!trade) return res.status(404).send('Trade not found');

    if (!trade.comments) trade.comments = [];

    const index = parseInt(commentIndex, 10);
    if (isNaN(index) || index < 0 || index >= trade.comments.length) {
      return res.status(404).send('Invalid comment index');
    }

    // Remove associated files from disk
    const commentToDelete = trade.comments[index];
    if (commentToDelete.attachments && commentToDelete.attachments.length > 0) {
      commentToDelete.attachments.forEach(file => {
        deleteFileFromDisk(file.url);
      });
    }

    // Remove comment from trade comments
    trade.comments.splice(index, 1);
    saveData(data);

    req.session.save((err) => {
      if (err) console.error('Session save error:', err);
      res.redirect(`/admin/edit/${roomId}?trade=${tradeId}`);
    });
  } catch (err) {
    console.error('Error deleting comment:', err);
    res.status(500).send('Error deleting comment');
  }
});

// Delete Image
app.post('/admin/edit/:roomId/delete-image/:tradeId/:imageIndex', (req, res) => {
  try {
    const data = getData();
    const { roomId, tradeId, imageIndex } = req.params;

    const room = findRoomById(data, roomId);
    if (!room) return res.status(404).send('Room not found');

    const trade = room.trades.find(t => String(t.id) === String(tradeId));
    if (!trade) return res.status(404).send('Trade not found');

    const index = parseInt(imageIndex, 10);
    if (isNaN(index) || !Array.isArray(trade.images) || index < 0 || index >= trade.images.length) {
      return res.status(404).send('Image not found');
    }

    const imageToDelete = trade.images[index];
    if (imageToDelete && imageToDelete.url) {
      deleteFileFromDisk(imageToDelete.url);
    }

    trade.images.splice(index, 1);
    saveData(data);

    req.session.save((err) => {
      if (err) console.error('Session save error:', err);
      res.redirect(`/admin/edit/${roomId}?trade=${tradeId}`);
    });
  } catch (err) {
    console.error('Error deleting image:', err);
    res.status(500).send('Error deleting image');
  }
});

// Download Image
app.get('/download/:roomId/:tradeId/:filename', (req, res) => {
  try {
    const data = getData();
    const room = findRoomById(data, req.params.roomId);
    if (!room) return res.status(404).send('Room not found');

    const trade = room.trades.find(t => t.id === req.params.tradeId);
    if (!trade || !trade.files) return res.status(404).send('File not found');

    const file = trade.files.find(f => f.filename === req.params.filename);
    if (!file) return res.status(404).send('File not found');

    const filePath = path.join(__dirname, 'public', file.url);
    if (fs.existsSync(filePath)) {
      res.download(filePath, file.originalName);
    } else {
      res.status(404).send('File not found on server');
    }
  } catch (err) {
    console.error('Download error:', err);
    res.status(500).send('Error downloading file');
  }
});

// Delete File
app.post('/admin/edit/:roomId/delete-file/:tradeId/:fileIndex', (req, res) => {
  try {
    const data = getData();
    const { roomId, tradeId, fileIndex } = req.params;

    // 1. Find Room
    const room = findRoomById(data, roomId);
    if (!room) return res.status(404).send('Room not found');

    // 2. Find Trade (Converting both to String prevents strict type mismatches)
    const trade = room.trades ? room.trades.find(t => String(t.id) === String(tradeId)) : null;
    if (!trade) return res.status(404).send('Trade not found');

    // 3. Parse and Validate File Index
    const index = parseInt(fileIndex, 10);
    if (isNaN(index) || !Array.isArray(trade.files) || index < 0 || index >= trade.files.length) {
      return res.status(404).send('File not found');
    }

    // 4. Remove file from disk
    const fileToDelete = trade.files[index];
    if (fileToDelete && fileToDelete.url) {
      deleteFileFromDisk(fileToDelete.url);
    }

    // 5. Remove file entry from array
    trade.files.splice(index, 1);

    // 6. Save data and redirect
    saveData(data);
    req.session.save((err) => {
      if (err) console.error('Session save error:', err);
      res.redirect(`/admin/edit/${roomId}?trade=${tradeId}`);
    });
  } catch (err) {
    console.error('Error deleting file:', err);
    res.status(500).send('Error deleting file');
  }
});

// Delete Files of a trade
app.post('/admin/edit/:roomId/delete-all-files/:tradeId', (req, res) => {
  try {
    const data = getData();
    const { roomId, tradeId } = req.params;

    const room = findRoomById(data, roomId);
    if (!room) return res.status(404).send('Room not found');

    const trade = room.trades.find(t => t.id === tradeId);
    if (!trade) return res.status(404).send('Trade not found');

    if (trade.files && trade.files.length > 0) {
      trade.files.forEach(file => {
        deleteFileFromDisk(file.url);
      });
      trade.files = [];
      saveData(data);
    }

    req.session.save((err) => {
      if (err) console.error('Session save error:', err);
      res.redirect(`/admin/edit/${roomId}?trade=${tradeId}`);
    });
  } catch (err) {
    console.error('Error deleting all files:', err);
    res.status(500).send('Error deleting files');
  }
});

// Change Draft Status
app.post('/admin/toggle-publish/:id', (req, res) => {
  try {
    const data = getData();
    const room = findRoomById(data, req.params.id);

    if (room) {
      room.status = room.status === 'published' ? 'draft' : 'published';
      saveData(data);
    }

    req.session.save((err) => {
      if (err) console.error('Session save error:', err);
      res.redirect(`/admin/edit/${req.params.id}`);
    });
  } catch (err) {
    console.error('Error toggling publish status:', err);
    res.status(500).send('Error toggling publish status');
  }
});

// Redirect
app.post('/admin/edit/:roomId/delete-comment/:tradeId/:commentId', (req, res) => {
  const { roomId, tradeId, commentId } = req.params;
  const data = getData();
  const { room } = findRoomAndHouseById(data, roomId);

  if (room && room.trades) {
    const trade = room.trades.find(t => t.id === tradeId);
    if (trade && trade.comments) {
      const commentIndex = trade.comments.findIndex(c => String(c.id) === String(commentId));
      if (commentIndex !== -1) {
        const commentToDelete = trade.comments[commentIndex];
        if (commentToDelete.attachments && commentToDelete.attachments.length > 0) {
          commentToDelete.attachments.forEach(file => {
            deleteFileFromDisk(file.url);
          });
        }
        trade.comments.splice(commentIndex, 1);
        saveData(data);
      }
    }
  }

  res.redirect(`/admin/edit/${roomId}?trade=${tradeId}`);
});

// =================
// SCHEDULE ROUTES 
// =================

app.post('/admin/houses/schedule/:houseId/jobs', (req, res) => {
    const { houseId } = req.params;
    const { name, startDate, endDate } = req.body;

    if (!name || !startDate || !endDate) {
        return res.status(400).json({
            success: false,
            error: 'All fields are required'
        });
    }

    const data = getData();

    const house = data.houses.find(h => h.id === houseId);

    if (!house) {
        return res.status(404).json({
            success: false,
            error: 'House not found'
        });
    }

    if (!house.schedule) {
        house.schedule = { jobs: [] };
    }

    if (!house.schedule.jobs) {
        house.schedule.jobs = [];
    }

    const job = {
        id: Date.now().toString(),
        name,
        startDate,
        endDate
    };

    house.schedule.jobs.push(job);

    saveData(data);

    res.json({
        success: true,
        job
    });
});

// Update job
app.put('/admin/houses/schedule/:houseId/jobs/:jobId', (req, res) => {
  try {
    const data = getData();
    const house = data.houses.find(h => h.id === req.params.houseId);
    
    if (!house) return res.status(404).json({ error: 'House not found' });
    
    if (!house.schedule) return res.status(404).json({ error: 'Schedule not found' });
    
    const job = house.schedule.jobs.find(j => j.id === req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    
    const { name, startDate, endDate } = req.body;
    if (name) job.name = name.trim();
    if (startDate) job.startDate = startDate;
    if (endDate) job.endDate = endDate;
    
    saveData(data);
    res.json({ success: true, job });
  } catch (err) {
    console.error('Error updating job:', err);
    res.status(500).json({ error: 'Failed to update job' });
  }
});

// Delete job
app.delete('/admin/houses/schedule/:houseId/jobs/:jobId', (req, res) => {
  try {
    const data = getData();
    const house = data.houses.find(h => h.id === req.params.houseId);
    
    if (!house) return res.status(404).json({ error: 'House not found' });
    
    if (house.schedule) {
      house.schedule.jobs = house.schedule.jobs.filter(j => j.id !== req.params.jobId);
      saveData(data);
    }
    
    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting job:', err);
    res.status(500).json({ error: 'Failed to delete job' });
  }
});

// View schedule page
// app.get('/admin/houses/schedule/:houseId', (req, res) => {
//   try {
//     const data = getData();
//     const house = data.houses.find(h => h.id === req.params.houseId);
    
//     if (!house) return res.status(404).send('House not found');
    
//     // Initialize schedule if it doesn't exist
//     if (!house.schedule) {
//       house.schedule = { jobs: [] };
//       saveData(data);
//     }
    
//     res.render('schedule', { house });
//   } catch (err) {
//     console.error('Error loading schedule:', err);
//     res.status(500).send('Error loading schedule');
//   }
// });

app.get('/admin/houses/schedule/:houseId', requireAuth, async (req, res) => {
  try {
    const data = getData();
    const house = data.houses.find(h => h.id === req.params.houseId);
    if (!house) return res.status(404).send('House not found');
    if (!house.schedule) {
      house.schedule = { jobs: [] };
      saveData(data);
    }

    // Generate QR code for the public schedule URL
    const publicUrl = `${req.protocol}://${req.get('host')}/house/schedule/${house.id}`;
    let qrDataUrl = null;
    try {
      qrDataUrl = await QRCode.toDataURL(publicUrl);
    } catch (err) {
      console.error('QR generation error:', err);
    }

    res.render('schedule', { house, qrDataUrl });
  } catch (err) {
    console.error('Error loading schedule:', err);
    res.status(500).send('Error loading schedule');
  }
});

// app.get('/house/schedule/:houseId', (req, res) => {
//   try {
//     const data = getData();
//     const house = data.houses.find(h => h.id === req.params.houseId);
    
//     if (!house) return res.status(404).send('House not found');
    
//     if (!house.schedule) {
//       house.schedule = { jobs: [] };
//       saveData(data);
//     }
    
//     res.render('public-schedule', { house });
//   } catch (err) {
//     console.error('Error loading public schedule:', err);
//     res.status(500).send('Error loading schedule');
//   }
// });

app.get('/house/schedule/:houseId', async (req, res) => {
  try {
    const data = getData();
    const house = data.houses.find(h => h.id === req.params.houseId);
    if (!house) return res.status(404).send('House not found');
    if (!house.schedule) {
      house.schedule = { jobs: [] };
      saveData(data);
    }
    // Optionally generate QR here as well, but not needed for public view
    res.render('public-schedule', { house });
  } catch (err) {
    console.error('Error loading public schedule:', err);
    res.status(500).send('Error loading schedule');
  }
});

// =====================
// PUBLIC VIEW ROUTES
// =====================

app.get('/house/:id', (req, res) => {
  try {
    const data = getData();
    const house = data.houses.find(h => h.id === req.params.id);

    if (!house) return res.status(404).send('House project not found');

    res.render('house', { house, rooms: house.rooms || [] });
  } catch (err) {
    console.error('House view error:', err);
    res.status(500).send('Error loading house');
  }
});

registerFont(path.join(__dirname, 'fonts', 'Roboto-Regular.ttf'), { family: 'Roboto' });
registerFont(path.join(__dirname, 'fonts', 'Roboto-Bold.ttf'), { family: 'Roboto-Bold' });

app.get('/room/:id', async (req, res) => {
  try {
    const data = getData();
    const { room, house } = findRoomAndHouseById(data, req.params.id);

    if (!room) return res.status(404).send('Room specifications not found');

    if (room.status !== 'published') {
      if (!req.session || !req.session.isAdmin) {
        if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
          return res.status(401).json({ error: 'Unauthorized - Room not published' });
        }
        return res.redirect('/error/401');
      }
    }

    const roomUrl = `${req.protocol}://${req.get('host')}/room/${room.id}`;

    // Generate QR code as buffer
    const qrBuffer = await QRCode.toBuffer(roomUrl, {
      width: 300,
      margin: 2
    });

    // Create canvas with title
    const title = `${house ? house.name : ''} - ${room.name}`;
    const canvas = createCanvas(300, 360);
    const ctx = canvas.getContext('2d');

    // White background
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, 300, 360);

    // Load QR image
    const img = await loadImage(qrBuffer);

    // Draw QR code
    ctx.drawImage(img, 0, 50, 300, 300);

    // Draw title text with registered font
    ctx.fillStyle = '#000000';
    ctx.font = 'bold 16px "Roboto-Bold", "Arial", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(title, 150, 15);
    // Draw subtitle
    ctx.fillStyle = '#666666';
    ctx.font = '10px "Roboto", "Arial", sans-serif';
    // Convert to data URL
    const qrCodeUrl = canvas.toDataURL('image/png');

    const activeTrade = req.query.trade || (room.trades[0] ? room.trades[0].id : '');

    res.render('room', {
      room,
      house: house || null,
      activeTrade,
      qrCodeUrl,
      roomUrl
    });
  } catch (err) {
    console.error('Room view error:', err);
    res.status(500).send('Error loading room');
  }
});

// Add Comment
app.post('/room/:roomId/comment', upload.array('attachments', 10), async (req, res) => {
  try {
    const data = getData();
    const { room, house } = findRoomAndHouseById(data, req.params.roomId);

    if (!room) return res.status(404).send('Room not found');

    const tradeId = req.body.tradeId;
    if (!tradeId) return res.status(400).send('Trade ID is required');

    const trade = room.trades.find(t => t.id === tradeId);
    if (!trade) return res.status(404).send('Trade not found');

    const houseFolder = house ? house.id : 'unassigned';
    const attachments = [];
    const mailAttachments = [];

    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        const saved = await saveUploadedFile(file, houseFolder, room.id);
        const filePath = path.join(__dirname, 'public', 'uploads', houseFolder, room.id, saved.filename);

        attachments.push({
          url: `/uploads/${houseFolder}/${room.id}/${saved.filename}`,
          originalName: file.originalname,
          filename: saved.filename,
          type: saved.mimetype,
          size: fs.statSync(filePath).size
        });

        mailAttachments.push({
          filename: file.originalname,
          path: filePath
        });
      }
    }

    const newComment = {
      id: Date.now().toString(),
      author: req.body.author || 'Anonymous Trade',
      text: req.body.text,
      timestamp: new Date().toISOString().replace('T', ' ').substring(0, 16),
      attachments: attachments
    };

    if (!trade.comments) trade.comments = [];
    trade.comments.unshift(newComment);

    saveData(data);

    // Prepare email parameters
    const activeTrade = req.body.activeTrade || tradeId;
    const houseName = house ? (house.name || house.id) : 'Unassigned';
    const roomName = room.name || room.id;
    const tradeName = trade.name || trade.id;

    const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
    const replyUrl = `${baseUrl}/room/${req.params.roomId}?trade=${activeTrade}`;

    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: process.env.RECEIVER_ADMIN_EMAIL,
      subject: `New comment by '${newComment.author}' in '${houseName}' - '${roomName}' - '${tradeName}'`,
      attachments: mailAttachments,
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; background-color: #f4f6f8; margin: 0; padding: 20px; color: #333; }
            .container { max-width: 600px; background: #ffffff; padding: 24px; border-radius: 8px; border: 1px solid #e0e0e0; margin: 0 auto; }
            .header { border-bottom: 2px solid #0056b3; padding-bottom: 12px; margin-bottom: 20px; }
            .header h2 { margin: 0; color: #0056b3; font-size: 20px; }
            .meta-table { width: 100%; margin-bottom: 20px; border-collapse: collapse; }
            .meta-table td { padding: 6px 0; font-size: 14px; }
            .meta-label { font-weight: bold; color: #555; width: 100px; }
            .comment-box { background: #f8f9fa; border-left: 4px solid #0056b3; padding: 15px; border-radius: 4px; margin-bottom: 24px; font-size: 15px; white-space: pre-wrap; }
            .button { display: inline-block; background-color: #0056b3; color: #ffffff !important; text-decoration: none; padding: 12px 20px; border-radius: 5px; font-weight: bold; font-size: 14px; }
            .footer { margin-top: 24px; font-size: 12px; color: #777; border-top: 1px solid #eee; padding-top: 12px; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h2>New Comment Received</h2>
            </div>
            
            <table class="meta-table">
              <tr><td class="meta-label">Author:</td><td>${newComment.author}</td></tr>
              <tr><td class="meta-label">House:</td><td>${houseName}</td></tr>
              <tr><td class="meta-label">Room:</td><td>${roomName}</td></tr>
              <tr><td class="meta-label">Trade:</td><td>${tradeName}</td></tr>
              <tr><td class="meta-label">Date:</td><td>${newComment.timestamp}</td></tr>
            </table>

            <div class="comment-box">
              ${newComment.text || '<i>No text content</i>'}
            </div>

            <div style="text-align: center; margin: 30px 0;">
              <a href="${replyUrl}" class="button">View & Reply to Comment</a>
            </div>

            <div class="footer">
              This is an automated notification from JobHouse. Do not reply directly to this email.
            </div>
          </div>
        </body>
        </html>
      `
    };

    // Send email without blocking the user response flow
    transporter.sendMail(mailOptions).catch(err => console.error('Email sending failed:', err));

    // Redirect back with the same trade selected
    res.redirect(`/room/${req.params.roomId}?trade=${activeTrade}`);
  } catch (err) {
    console.error('Comment submission error:', err);
    res.status(500).send('Error adding comment');
  }
});

app.post('/admin/houses/:houseId/reorder-rooms', (req, res) => {
  try {
    const data = getData();
    const house = data.houses.find(h => h.id === req.params.houseId);
    if (!house) return res.status(404).json({ error: 'House not found' });

    const { roomOrder } = req.body;
    // Sort rooms based on the new order
    house.rooms.sort((a, b) => roomOrder.indexOf(a.id) - roomOrder.indexOf(b.id));
    saveData(data);
    res.json({ success: true });
  } catch (err) {
    console.error('Error reordering rooms:', err);
    res.status(500).json({ error: 'Failed to reorder rooms' });
  }
});


// Reorder Images
app.post('/admin/rooms/:roomId/trades/:tradeId/reorder-images', (req, res) => {
  try {
    const data = getData();
    const { roomId, tradeId } = req.params;
    const { imageOrder } = req.body;

    const { room } = findRoomAndHouseById(data, roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });

    const trade = room.trades.find(t => t.id === tradeId);
    if (!trade) return res.status(404).json({ error: 'Trade not found' });

    if (!trade.images) trade.images = [];

    // Reorder images based on the new order
    const reorderedImages = [];
    imageOrder.forEach(index => {
      if (index >= 0 && index < trade.images.length) {
        reorderedImages.push(trade.images[index]);
      }
    });

    // Keep any images that weren't in the order array (just in case)
    const usedIndices = new Set(imageOrder);
    for (let i = 0; i < trade.images.length; i++) {
      if (!usedIndices.has(i)) {
        reorderedImages.push(trade.images[i]);
      }
    }

    trade.images = reorderedImages;
    saveData(data);
    res.json({ success: true });
  } catch (err) {
    console.error('Error reordering images:', err);
    res.status(500).json({ error: 'Failed to reorder images' });
  }
});

// Reorder Files
app.post('/admin/rooms/:roomId/trades/:tradeId/reorder-files', (req, res) => {
  try {
    const data = getData();
    const { roomId, tradeId } = req.params;
    const { fileOrder } = req.body;

    const { room } = findRoomAndHouseById(data, roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });

    const trade = room.trades.find(t => t.id === tradeId);
    if (!trade) return res.status(404).json({ error: 'Trade not found' });

    if (!trade.files) trade.files = [];

    // Reorder files based on the new order
    const reorderedFiles = [];
    fileOrder.forEach(index => {
      if (index >= 0 && index < trade.files.length) {
        reorderedFiles.push(trade.files[index]);
      }
    });

    // Keep any files that weren't in the order array (just in case)
    const usedIndices = new Set(fileOrder);
    for (let i = 0; i < trade.files.length; i++) {
      if (!usedIndices.has(i)) {
        reorderedFiles.push(trade.files[i]);
      }
    }

    trade.files = reorderedFiles;
    saveData(data);
    res.json({ success: true });
  } catch (err) {
    console.error('Error reordering files:', err);
    res.status(500).json({ error: 'Failed to reorder files' });
  }
});

app.post('/admin/rooms/:roomId/duplicate', (req, res) => {
  const roomId = req.params.roomId;
  const { newName, houseId } = req.body;

  try {
    const data = getData();
    
    // Find the original room and its house
    let originalRoom = null;
    let originalHouse = null;
    
    for (const house of data.houses) {
      const foundRoom = house.rooms.find(r => r.id === roomId);
      if (foundRoom) {
        originalRoom = foundRoom;
        originalHouse = house;
        break;
      }
    }

    if (!originalRoom) {
      return res.status(404).json({ message: 'Room not found' });
    }

    // Find the target house (use the provided houseId or the original house)
    let targetHouse = null;
    if (houseId) {
      targetHouse = data.houses.find(h => h.id === houseId);
    }
    if (!targetHouse) {
      targetHouse = originalHouse;
    }

    if (!targetHouse) {
      return res.status(404).json({ message: 'Target house not found' });
    }

    // Generate a new unique room ID
    const baseId = `${targetHouse.id}-${newName.toLowerCase().trim().replace(/[^a-z0-9]/g, '-')}`;
    let newRoomId = baseId;
    let counter = 1;
    
    // Check if room ID already exists and add counter if needed
    while (targetHouse.rooms.some(r => r.id === newRoomId)) {
      newRoomId = `${baseId}-${counter}`;
      counter++;
    }

    // Create the duplicate room with deep copy of trades
    const newRoom = {
      id: newRoomId,
      name: newName || `${originalRoom.name} (Copy)`,
      status: originalRoom.status || 'draft',
      trades: originalRoom.trades.map(trade => ({
        id: `${trade.id}-copy-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
        name: trade.name,
        renderUrl: '', // Don't copy files to avoid duplicates
        planUrl: '',
        notes: '',
        images: [],
        files: [],
        comments: []
      }))
    };

    // Add the new room to the target house
    targetHouse.rooms.push(newRoom);
    
    // Save the data
    saveData(data);

    res.status(200).json({ 
      success: true, 
      roomId: newRoom.id,
      message: 'Room duplicated successfully' 
    });
  } catch (error) {
    console.error('Error duplicating room:', error);
    res.status(500).json({ message: 'Failed to duplicate room' });
  }
});

app.get('/error/400', (req, res) => {
  res.status(400).render('errors/400');
});

app.get('/error/401', (req, res) => {
  res.status(401).render('errors/401');
});

app.get('/error/403', (req, res) => {
  res.status(403).render('errors/403');
});

app.get('/error/502', (req, res) => {
  res.status(502).render('errors/502');
});

app.get('/error/503', (req, res) => {
  res.status(503).render('errors/503');
});

// 404 Catch-all - MUST BE LAST BEFORE ERROR HANDLER
app.use((req, res) => {
  res.status(404).render('errors/404');
});

// 500 Error Handler - ABSOLUTELY LAST
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).render('errors/500');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Admin panel running: http://localhost:${PORT}/admin`);
});