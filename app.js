const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const QRCode = require('qrcode');

const app = express();
const DATA_FILE = path.join(__dirname, 'data', 'jobsite_data.json');

// Middleware
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// File Upload Configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, 'public', 'uploads');
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

// JSON Helpers
function getData() {
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ rooms: [] }, null, 2));
  }
  const rawData = fs.readFileSync(DATA_FILE);
  return JSON.parse(rawData);
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// Routes

// 1. Admin Dashboard / Room Manager
app.get('/admin', (req, res) => {
  const data = getData();
  res.render('admin', { rooms: data.rooms });
});

// Create Room (Draft)
app.post('/admin/rooms', (req, res) => {
  const data = getData();
  const newRoom = {
    id: req.body.roomName.toLowerCase().replace(/[^a-z0-9]/g, '-'),
    name: req.body.roomName,
    status: 'draft',
    trades: [
      { id: 'electrical', name: 'Electrical', renderUrl: '', planUrl: '', notes: '' },
      { id: 'plumbing', name: 'Plumbing', renderUrl: '', planUrl: '', notes: '' },
      { id: 'hvac', name: 'HVAC', renderUrl: '', planUrl: '', notes: '' }
    ],
    comments: []
  };
  data.rooms.push(newRoom);
  saveData(data);
  res.redirect(`/admin/edit/${newRoom.id}`);
});

// Edit Room Interface
// Edit Room Interface
app.get('/admin/edit/:id', (req, res) => {
  const data = getData();
  const room = data.rooms.find(r => r.id === req.params.id);
  
  if (!room) return res.status(404).send('Room not found');

  // Capture selected trade from query string (e.g. ?trade=electrical)
  const selectedTrade = req.query.trade || (room.trades[0] ? room.trades[0].id : '');

  // Pass selectedTrade into the EJS template
  res.render('admin-edit', { room, selectedTrade });
});

// Add Trade Tab
app.post('/admin/edit/:id/add-trade', (req, res) => {
  const data = getData();
  const room = data.rooms.find(r => r.id === req.params.id);
  if (room) {
    const tradeName = req.body.tradeName;
    const tradeId = tradeName.toLowerCase().replace(/[^a-z0-9]/g, '-');
    room.trades.push({ id: tradeId, name: tradeName, renderUrl: '', planUrl: '', notes: '' });
    saveData(data);
  }
  res.redirect(`/admin/edit/${req.params.id}`);
});

// Delete Trade Tab
app.post('/admin/edit/:id/delete-trade/:tradeId', (req, res) => {
  const data = getData();
  const room = data.rooms.find(r => r.id === req.params.id);
  if (room) {
    room.trades = room.trades.filter(t => t.id !== req.params.tradeId);
    saveData(data);
  }
  res.redirect(`/admin/edit/${req.params.id}`);
});

// Save Draft Updates
app.post('/admin/edit/:id/save', upload.fields([
  { name: 'render', maxCount: 1 },
  { name: 'plan', maxCount: 1 }
]), (req, res) => {
  const data = getData();
  const room = data.rooms.find(r => r.id === req.params.id);
  
  if (room) {
    const tradeId = req.body.tradeId;
    const trade = room.trades.find(t => t.id === tradeId);
    
    if (trade) {
      trade.notes = req.body.notes || '';
      if (req.files['render']) {
        trade.renderUrl = `/uploads/${req.files['render'][0].filename}`;
      }
      if (req.files['plan']) {
        trade.planUrl = `/uploads/${req.files['plan'][0].filename}`;
      }
    }
    saveData(data);
  }
  res.redirect(`/admin/edit/${req.params.id}?trade=${req.body.tradeId}`);
});

app.post('/admin/toggle-publish/:id', (req, res) => {
  const data = getData();
  const room = data.rooms.find(r => r.id === req.params.id);
  
  if (room) {
    // Toggle between published and draft
    room.status = room.status === 'published' ? 'draft' : 'published';
    saveData(data);
  }
  
  // Redirect back to the edit view for the current room
  res.redirect(`/admin/edit/${req.params.id}`);
});

// Publish Room & Generate QR Code
app.post('/admin/publish/:id', (req, res) => {
  const data = getData();
  const room = data.rooms.find(r => r.id === req.params.id);
  if (room) {
    room.status = 'published';
    saveData(data);
  }
  res.redirect('/admin');
});



// 2. Public Room Viewer Page (Scan Target)
app.get('/room/:id', async (req, res) => {
  const data = getData();
  const room = data.rooms.find(r => r.id === req.params.id);
  if (!room) return res.status(404).send('Room specifications not found');

  const roomUrl = `${req.protocol}://${req.get('host')}/room/${room.id}`;
  const qrCodeUrl = await QRCode.toDataURL(roomUrl);

  const activeTrade = req.query.trade || (room.trades[0] ? room.trades[0].id : '');

  res.render('room', {
    room,
    activeTrade,
    qrCodeUrl,
    roomUrl
  });
});

// Add Public Comment
app.post('/room/:id/comment', (req, res) => {
  const data = getData();
  const room = data.rooms.find(r => r.id === req.params.id);
  if (room) {
    const newComment = {
      author: req.body.author || 'Anonymous Trade',
      text: req.body.text,
      timestamp: new Date().toISOString().replace('T', ' ').substring(0, 16)
    };
    room.comments.unshift(newComment);
    saveData(data);
  }
  res.redirect(`/room/${req.params.id}?trade=${req.body.activeTrade}`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Job Site Server running on http://localhost:${PORT}/admin`));