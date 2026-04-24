const express = require('express');
const path = require('path');
const data = require('./data.json');

const app = express();
const PORT = process.env.PORT || 3000;

// Serve static files from the public folder
app.use(express.static(path.join(__dirname, 'public')));

// Optional: simple API endpoint to get site config
app.get('/api/config', (req, res) => {
  res.json(data);
});

// Catch-all: always serve index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Landing page: http://localhost:${PORT}`);
});
