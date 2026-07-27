const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/healthController');

router.get('/health', ctrl.health);
router.get('/ready', ctrl.ready);

module.exports = router;
