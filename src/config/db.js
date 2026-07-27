const mongoose = require('mongoose');
const config = require('./index');
const logger = require('../utils/logger');

/**
 * Connect to MongoDB with sensible production defaults.
 * Mongoose 8 enables strictQuery by default.
 */
const connectDB = async () => {
  try {
    mongoose.set('strictQuery', true);

    // Production-leaning options without sacrificing dev DX.
    const options = {
      autoIndex: config.env !== 'production', // build indexes in dev only
      serverSelectionTimeoutMS: 10000,
    };

    await mongoose.connect(config.mongo.uri, options);

    logger.info('MongoDB connected', {
      host: mongoose.connection.host,
      db: mongoose.connection.name,
    });

    mongoose.connection.on('error', (err) => {
      logger.error('MongoDB connection error', { error: err.message });
    });

    mongoose.connection.on('disconnected', () => {
      logger.warn('MongoDB disconnected');
    });
  } catch (err) {
    logger.error('Failed to connect to MongoDB', { error: err.message });
    throw err;
  }
};

module.exports = connectDB;
