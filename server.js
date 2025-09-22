const express = require('express');
const axios = require('axios');
const WebSocket = require('ws');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Store active users and their email data
const activeUsers = new Map();
const monitoringIntervals = new Map();

// Your bot token and API URL
const BOT_TOKEN = process.env.BOT_TOKEN || "YOUR_BOT_TOKEN_HERE";
const BOT_API_URL = `https://api.telegram.org/bot${BOT_TOKEN}/`;

// Store last known message count for each user
const lastMessageCounts = new Map();

// Function to send Telegram message
async function sendTelegramMessage(chatId, message) {
    try {
        await axios.post(`${BOT_API_URL}sendMessage`, {
            chat_id: chatId,
            text: message,
            parse_mode: 'Markdown'
        });
    } catch (error) {
        console.error(`Failed to send message to ${chatId}:`, error.message);
    }
}

// Function to check inbox for new messages
async function checkInbox(chatId, email, token) {
    try {
        const response = await axios.get('https://api.mail.tm/messages', {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });
        
        const messages = response.data['hydra:member'] || [];
        const currentMessageCount = messages.length;
        const lastCount = lastMessageCounts.get(chatId) || 0;
        
        // If there are new messages
        if (currentMessageCount > lastCount) {
            const newMessages = messages.slice(0, currentMessageCount - lastCount);
            
            for (const message of newMessages) {
                try {
                    // Get full message content
                    const messageDetail = await axios.get(`https://api.mail.tm/messages/${message.id}`, {
                        headers: {
                            'Authorization': `Bearer ${token}`
                        }
                    });
                    
                    const fullMessage = messageDetail.data;
                    
                    // Format notification message exactly as specified
                    let notificationMsg = "📩 New Mail Received In Your Email ID 🪧\n\n";
                    notificationMsg += `📇 From : ${message.from.address}\n\n`;
                    notificationMsg += `🗒️ Subject : ${message.subject}\n\n`;
                    
                    // Get message content
                    let content = fullMessage.text || fullMessage.html || 'No content available';
                    
                    // Clean HTML tags if present
                    content = content.replace(/<[^>]*>/g, '');
                    
                    // Limit content length to avoid Telegram message limits
                    if (content.length > 800) {
                        content = content.substring(0, 800) + '...';
                    }
                    
                    notificationMsg += `💬 Text : *${content}*`;
                    
                    // Send notification
                    await sendTelegramMessage(chatId, notificationMsg);
                    
                } catch (messageError) {
                    console.error(`Failed to get message details for ${message.id}:`, messageError.message);
                }
            }
            
            // Update last message count
            lastMessageCounts.set(chatId, currentMessageCount);
        }
        
    } catch (error) {
        if (error.response && error.response.status === 401) {
            // Token expired, try to refresh
            console.log(`Token expired for user ${chatId}, attempting to refresh...`);
            
            const userData = activeUsers.get(chatId);
            if (userData && userData.password) {
                try {
                    const tokenResponse = await axios.post('https://api.mail.tm/token', {
                        address: email,
                        password: userData.password
                    });
                    
                    if (tokenResponse.data.token) {
                        // Update stored token
                        userData.token = tokenResponse.data.token;
                        activeUsers.set(chatId, userData);
                        
                        // Retry checking inbox with new token
                        setTimeout(() => checkInbox(chatId, email, tokenResponse.data.token), 1000);
                    }
                } catch (refreshError) {
                    console.error(`Failed to refresh token for ${chatId}:`, refreshError.message);
                }
            }
        } else {
            console.error(`Failed to check inbox for ${chatId}:`, error.message);
        }
    }
}

// Start monitoring for a user
function startMonitoring(chatId, email, token, password) {
    // Stop existing monitoring if any
    if (monitoringIntervals.has(chatId)) {
        clearInterval(monitoringIntervals.get(chatId));
    }
    
    // Store user data
    activeUsers.set(chatId, { email, token, password });
    
    // Initial message count check
    checkInbox(chatId, email, token);
    
    // Start monitoring every 15 seconds
    const interval = setInterval(() => {
        checkInbox(chatId, email, token);
    }, 15000);
    
    monitoringIntervals.set(chatId, interval);
    
    console.log(`Started monitoring for user ${chatId} with email ${email}`);
}

// Stop monitoring for a user
function stopMonitoring(chatId) {
    if (monitoringIntervals.has(chatId)) {
        clearInterval(monitoringIntervals.get(chatId));
        monitoringIntervals.delete(chatId);
    }
    
    activeUsers.delete(chatId);
    lastMessageCounts.delete(chatId);
    
    console.log(`Stopped monitoring for user ${chatId}`);
}

// API Routes

// Register new user for monitoring
app.post('/register-user', (req, res) => {
    const { chat_id, email, token, password } = req.body;
    
    if (!chat_id || !email || !token) {
        return res.status(400).json({ error: 'Missing required fields' });
    }
    
    // Start monitoring for this user
    startMonitoring(chat_id, email, token, password);
    
    res.json({ success: true, message: 'User registered for monitoring' });
});

// Stop monitoring for a user
app.post('/stop-monitoring', (req, res) => {
    const { chat_id } = req.body;
    
    if (!chat_id) {
        return res.status(400).json({ error: 'chat_id required' });
    }
    
    stopMonitoring(chat_id);
    
    res.json({ success: true, message: 'Monitoring stopped' });
});

// Get monitoring status
app.get('/status/:chat_id', (req, res) => {
    const chatId = parseInt(req.params.chat_id);
    const isMonitoring = monitoringIntervals.has(chatId);
    const userData = activeUsers.get(chatId);
    
    res.json({
        monitoring: isMonitoring,
        email: userData ? userData.email : null,
        message_count: lastMessageCounts.get(chatId) || 0
    });
});

// Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'running',
        active_users: activeUsers.size,
        uptime: process.uptime()
    });
});

// Get all active users (for debugging)
app.get('/active-users', (req, res) => {
    const users = Array.from(activeUsers.entries()).map(([chatId, userData]) => ({
        chat_id: chatId,
        email: userData.email,
        monitoring: monitoringIntervals.has(chatId)
    }));
    
    res.json({ users, count: users.length });
});

// Manual inbox check endpoint
app.post('/check-inbox', async (req, res) => {
    const { chat_id } = req.body;
    
    if (!chat_id) {
        return res.status(400).json({ error: 'chat_id required' });
    }
    
    const userData = activeUsers.get(parseInt(chat_id));
    if (!userData) {
        return res.status(404).json({ error: 'User not found' });
    }
    
    try {
        await checkInbox(parseInt(chat_id), userData.email, userData.token);
        res.json({ success: true, message: 'Inbox checked' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to check inbox', details: error.message });
    }
});

// Start server
app.listen(port, () => {
    console.log(`🚀 Email Monitor Backend running on port ${port}`);
    console.log(`🔄 Real-time inbox monitoring active`);
    console.log(`📡 Webhook endpoint: /register-user`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully');
    
    // Stop all monitoring intervals
    monitoringIntervals.forEach((interval, chatId) => {
        clearInterval(interval);
        console.log(`Stopped monitoring for user ${chatId}`);
    });
    
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('SIGINT received, shutting down gracefully');
    
    // Stop all monitoring intervals
    monitoringIntervals.forEach((interval, chatId) => {
        clearInterval(interval);
        console.log(`Stopped monitoring for user ${chatId}`);
    });
    
    process.exit(0);
});
