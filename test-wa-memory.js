const mongoose = require('mongoose');
const config = require('./src/config');
const whatsappController = require('./src/controllers/whatsappController');
const ConversationMemoryService = require('./src/services/ConversationMemoryService');
const ChatMessage = require('./src/models/ChatMessage');
const Conversation = require('./src/models/Conversation');
const User = require('./src/models/User');

async function test() {
  await mongoose.connect(config.mongo.uri);
  console.log('Connected to DB');

  const testPhone = '919999999999';
  
  // Clear any existing user/messages
  await User.deleteMany({ whatsappId: testPhone });
  
  // 1st question
  console.log('Sending Q1...');
  await whatsappController.processQuestion(testPhone, 'What is Section 51?', 'en');
  
  // Verify DB
  const user = await User.findOne({ whatsappId: testPhone });
  const count = await Conversation.countDocuments({ userId: user._id });
  console.log('Conversation DB count:', count);
  
  // 2nd question (Follow up)
  console.log('Sending Q2...');
  await whatsappController.processQuestion(testPhone, 'In Marathi', 'en');
  
  console.log('Memory Stats:', ConversationMemoryService.getStats());
  console.log('Done');
  process.exit(0);
}

test().catch(console.error);
