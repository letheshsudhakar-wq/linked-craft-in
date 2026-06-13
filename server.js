require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const { exec } = require('child_process');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_linkedcraft_token_key_123!';

// Middleware
app.use(cors());
app.use(express.json());

// Serve static frontend files from this directory
app.use(express.static(path.join(__dirname)));

// JWT token generation and verification helpers using Node.js crypto (no external jwt dependencies)
function generateToken(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${data}`).digest('base64url');
  return `${header}.${data}.${signature}`;
}

function verifyToken(token) {
  try {
    const [header, data, signature] = token.split('.');
    const expectedSig = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${data}`).digest('base64url');
    if (signature !== expectedSig) return null;
    return JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
  } catch (e) {
    return null;
  }
}

// Authentication Middleware
async function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  const decoded = verifyToken(token);
  if (!decoded || !decoded.email) {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }

  const user = await db.getUser(decoded.email);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  req.user = user;
  next();
}

// ----------------------------------------------------
// AUTH ENDPOINTS
// ----------------------------------------------------
app.post('/api/auth/signup', async (req, res) => {
  const { email, password } = req.body;
  try {
    const user = await db.createUser(email, password);
    const token = generateToken({ email: user.email });
    res.status(201).json({
      token,
      email: user.email,
      onboardingComplete: user.onboardingComplete
    });
  } catch (error) {
    res.status(400).json({ error: error.message || 'Signup failed' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const user = await db.verifyCredentials(email, password);
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    const token = generateToken({ email: user.email });
    res.json({
      token,
      email: user.email,
      onboardingComplete: user.onboardingComplete
    });
  } catch (error) {
    res.status(500).json({ error: 'Login server error' });
  }
});

// ----------------------------------------------------
// USER PROFILE / DATA ENDPOINTS
// ----------------------------------------------------
app.get('/api/user', authenticateToken, (req, res) => {
  // Return user info safely (without passwordHash)
  const { passwordHash, ...safeUserData } = req.user;
  
  // Inform the frontend if server-wide API keys/hosts are configured
  res.json({
    user: safeUserData,
    config: {
      hasServerClaudeKey: !!process.env.CLAUDE_API_KEY,
      hasServerOpenRouterKey: !!process.env.OPENROUTER_API_KEY,
      hasServerGroqKey: !!process.env.GROQ_API_KEY,
      ollamaHost: process.env.OLLAMA_HOST || 'http://127.0.0.1:11434'
    }
  });
});

app.post('/api/user/samples', authenticateToken, async (req, res) => {
  const { samples } = req.body;
  if (!Array.isArray(samples) || samples.length < 2) {
    return res.status(400).json({ error: 'Please provide at least 2 voice sample posts' });
  }
  try {
    const updated = await db.updateUser(req.user.email, {
      samples,
      onboardingComplete: true
    });
    const { passwordHash, ...safeUserData } = updated;
    res.json(safeUserData);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update voice samples' });
  }
});

app.post('/api/user/settings', authenticateToken, async (req, res) => {
  const { apiKey, apiEndpoint, apiProvider, model } = req.body;
  try {
    const updated = await db.updateUser(req.user.email, {
      apiKey: apiKey || '',
      apiEndpoint: apiEndpoint || 'https://api.anthropic.com/v1/messages',
      apiProvider: apiProvider || 'demo',
      model: model || 'claude-haiku-4-5'
    });
    const { passwordHash, ...safeUserData } = updated;
    res.json(safeUserData);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update user settings' });
  }
});

app.post('/api/history/reset', authenticateToken, async (req, res) => {
  try {
    const updated = await db.updateUser(req.user.email, {
      postsGenerated: 0,
      history: []
    });
    const { passwordHash, ...safeUserData } = updated;
    res.json(safeUserData);
  } catch (error) {
    res.status(500).json({ error: 'Failed to reset history' });
  }
});

// ----------------------------------------------------
// LINKEDIN API & AUTOMATED PUBLISHING ENDPOINTS
// ----------------------------------------------------
app.post('/api/user/linkedin', authenticateToken, async (req, res) => {
  const { linkedinAccessToken, linkedinPersonUrn } = req.body;
  try {
    const updated = await db.updateUser(req.user.email, {
      linkedinAccessToken: linkedinAccessToken || '',
      linkedinPersonUrn: linkedinPersonUrn || ''
    });
    const { passwordHash, ...safeUserData } = updated;
    res.json(safeUserData);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update LinkedIn API credentials' });
  }
});

app.get('/api/published', authenticateToken, (req, res) => {
  res.json(req.user.publishedPosts || []);
});

app.post('/api/publish', authenticateToken, async (req, res) => {
  const { text } = req.body;
  const user = req.user;

  if (!text) {
    return res.status(400).json({ error: 'Post text content is required' });
  }

  const isLive = !!(user.linkedinAccessToken && user.linkedinPersonUrn);

  let newPost = {
    id: 'post_' + Date.now(),
    text,
    timestamp: Date.now(),
    live: isLive,
    status: 'success',
    linkedinPostId: ''
  };

  if (isLive) {
    try {
      const response = await fetch('https://api.linkedin.com/v2/ugcPosts', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${user.linkedinAccessToken}`,
          'Content-Type': 'application/json',
          'X-Restli-Protocol-Version': '2.0.0'
        },
        body: JSON.stringify({
          author: user.linkedinPersonUrn,
          lifecycleState: 'PUBLISHED',
          specificContent: {
            'com.linkedin.ugc.ShareContent': {
              shareCommentary: {
                text: text
              },
              shareMediaCategory: 'NONE'
            }
          },
          visibility: {
            'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC'
          }
        })
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error("LinkedIn API error response:", errText);
        throw new Error(`LinkedIn rejected share. Check credentials/permissions.`);
      }

      const resData = await response.json();
      newPost.linkedinPostId = resData.id || '';
    } catch (err) {
      console.error("LinkedIn Post Exception:", err);
      return res.status(500).json({ error: `Failed to post to LinkedIn API: ${err.message}` });
    }
  } else {
    // Simulated Mode: wait 2 seconds
    await new Promise(resolve => setTimeout(resolve, 2000));
    newPost.linkedinPostId = 'urn:li:share:' + Math.floor(Math.random() * 10000000);
  }

  // Save published post to database
  const updatedPublished = [newPost, ...(user.publishedPosts || [])];
  await db.updateUser(user.email, {
    publishedPosts: updatedPublished
  });

  res.json({
    success: true,
    post: newPost
  });
});

// ----------------------------------------------------
// DEMO MOCK DATA ENGINE
// ----------------------------------------------------
const generateDemoDrafts = (topic, style, samples) => {
  const cleanedTopic = topic.trim().substring(0, 80) + (topic.length > 80 ? '...' : '');
  const userSamplesCombined = samples.join(' ').toLowerCase();
  const hasSaaS = userSamplesCombined.includes('saas') || topic.toLowerCase().includes('saas') || topic.toLowerCase().includes('software');
  const location = userSamplesCombined.includes('bangalore') || topic.toLowerCase().includes('bangalore') ? 'Bangalore' : 'India';

  let variations = [];
  if (style === 'storytelling') {
    variations = [
      `We were 3 days away from running out of cash. \n\nIt was 2021. I had pitch meetings lined up with 14 VCs. All of them rejected us. Some said the market size in ${hasSaaS ? 'SaaS' : 'India'} was too small. Others simply ghosted.\n\nI sat with my co-founder in our tiny office, wondering how we'd pay salaries. We decided to do something radical. Instead of chasing VCs, we spent that week calling our existing customers. We offered them a 25% discount if they paid upfront for the year. \n\nBy Friday, we closed 8 deals. We generated enough cash to survive another 4 months. We didn't need the VC money.\n\nThe lesson? Your customers are your best investors. Don't build to impress pitch decks. Build to solve actual bottlenecks. That is how sustainable empires are built. #Bootstrapping #Founders`,
      `Yesterday, a junior engineer broke our main production database.\n\nFor 45 minutes, our dashboard was down. Over 200 active users were staring at error screens. My phone was buzzing continuously. \n\nIn many startups, this is where the blame game starts. People panic. Slack threads get toxic. \n\nBut we did the opposite. We got on a huddle, patched the migration script, and got back online. Then, we wrote a public post-mortem document. No finger-pointing. We simply redesigned the access credentials so it couldn't happen again.\n\nIf your team is afraid of making mistakes, they will stop shipping. Psychological safety isn't a corporate HR buzzword. It's the engine of speed. #Engineering #StartupLife`,
      `We built a product for 6 months without showing it to a single customer. \n\nWe thought it was perfect. Beautiful code, gorgeous UI, smooth animations. We launched it with a big announcement. \n\nTotal signup count on day one? 14 people. Active users after a week? Zero.\n\nIt was a painful pill to swallow. We had built something we wanted, not what the market actually needed. We threw out 70% of the code and spent the next month interviewing founders. \n\nIf you are not embarrassed by the first version of your product, you launched too late. Build in public. Let your users co-design with you from day zero. #ProductDevelopment #Lessons`
    ];
  } else if (style === 'insight') {
    variations = [
      `3 non-obvious lessons I learned scaling teams from 0 to 50 in ${location}:\n\n1. The "superstar" developer from a FAANG company is often a bad fit for an early-stage startup. They are used to heavy infrastructure and slow release cycles. You need hackers who can ship clean-enough code in hours, not weeks.\n\n2. Hire for writing ability. In a hybrid or remote setup, clear writing is the ultimate filter. If a candidate cannot explain their past project in a 3-sentence summary, their code architecture will likely be just as messy.\n\n3. Speed is the only moat you have. Large enterprises have capital, brand authority, and distribution. Your only advantage is that you can make decisions and ship features in a afternoon, while they take three board meetings.\n\nOptimize for momentum over perfection. #ProductTeams #ScalingUp`,
      `Why most ${hasSaaS ? 'SaaS products' : 'B2B startups'} fail to hit product-market fit:\n\n- Building features instead of workflows: Customers don't buy APIs. They buy a solution that saves them 2 hours of manual excel sheet work.\n- Pricing too low: If you price your product at $9/month, you need 10,000 customers to survive. If you price at $500/month, you only need 180. Low pricing signals low value.\n- Ignoring distribution: A mediocre product with great distribution will defeat a perfect product with zero distribution every single time.\n\nStart thinking about marketing on the same day you write the first line of code. #Distribution #Business`,
      `The framework we use to prioritize feature requests from customers:\n\n- The loud minority: A single customer paying you $50/month demands a custom integration. If you build it, you waste engineering velocity. Never build for one client unless they pay 80% of your ARR.\n- The silent majority: Look at the logs. What are users clicking? Where do they drop off? Build solutions for patterns, not complaints.\n- The strategic bets: What feature will unlock the next tier of enterprise clients? \n\nProduct management is not about saying yes to everyone. It is about defending your engineering focus. #ProductManagement #SaaS`
    ];
  } else if (style === 'contrarian') {
    variations = [
      `Unpopular opinion: Networking events are a colossal waste of time for early-stage founders.\n\nYou don't need to exchange 50 business cards, drink lukewarm coffee at a tech summit, or listen to panel discussions about "industry trends." \n\nThe best founders I know are invisible. They aren't at mixers. They are sitting in their offices, talking to users, writing code, and hiring talent. \n\nIf your product is great, you don't need to network. Customers will seek you out. If your product is broken, no amount of networking will save your business. \n\nStop networking. Start building. #StartupTips #Focus`,
      `Work-life balance is a myth during the first 24 months of starting a company.\n\nYou can read all the wellness newsletters you want, but the reality of building a business from zero is brutal. It demands extreme obsession. You will think about your product in the shower, on weekends, and at dinners.\n\nIf you want a standard 9-to-6 routine, do not start a company. Join a mid-sized organization. Both paths are completely valid, but pretending you can build a category-defining startup while working 35 hours a week is selling a lie.\n\nObsession is the price of entry. #FounderReality #Startups`,
      `Stop looking for a co-founder. Just start building alone.\n\nI see so many aspiring builders delay their launch by 12 months because they "can't find a technical co-founder" or "need a marketing head."\n\nThis is just a sophisticated form of procrastination. If you can't code, use no-code tools or build a manual concierge service. If you can't sell, learn to write. \n\nOnce you get your first 10 paying customers, finding a co-founder becomes easy because you have proof of concept. Momentum attracts partners. Standing still does not. #Solopreneur #Entrepreneurship`
    ];
  } else {
    variations = [
      `How to write a cold email that actually gets a response from busy executives (a simple 4-step checklist):\n\n1. Subject line: Keep it under 5 words. Make it sound like an internal email. E.g., "Feedback on [Product]" instead of "Introducing our AI-powered SaaS platform."\n\n2. The Hook: Show you did 5 minutes of research. Reference a recent podcast they did or a specific feature they shipped.\n\n3. The Pitch: State exactly what you do and what value you bring in 2 sentences. No jargon. Use numbers. "We helped company X reduce server costs by 32%."\n\n4. The Call to Action: Make it frictionless. "Are you open to a 10-minute chat next Thursday at 2 PM?" rather than "Let me know when you are free."\n\nWe used this exact template to secure our first enterprise pilot deals. #ColdEmailing #Sales`,
      `How to run an effective 15-minute daily standup with your engineering team:\n\n- Never read status updates: If developers are just saying "yesterday I did X, today I do Y," put it in Slack. Don't waste meeting time.\n- Focus on blockers: The only question that matters is "What is stopping you from shipping today's ticket?"\n- Keep it standing: Literally. If everyone stands up, the meeting naturally wraps up in under 12 minutes.\n- Take details offline: If two engineers start arguing about code architecture, stop them. "Discuss this in a separate huddle."\n\nTime is the most expensive resource in a startup. Protect it. #Agile #Engineering`,
      `A step-by-step framework to launch a new product feature without overwhelming your customer support team:\n\n1. Internal beta: Let your own team use it for 3 days. You will catch 80% of the obvious bugs here.\n2. Beta toggle: Roll it out to 10% of your power users. Add an easy feedback button directly next to the new interface.\n3. Documentation: Write a simple 3-step FAQ page with screenshots before releasing it globally.\n4. Public rollout: Ship to 100%. Monitor server latency and error rates for the next 2 hours.\n\nGradual rollouts save developer sanity. #ProductLaunch #Tech`
    ];
  }

  return variations.map(v => {
    return v.replace(/bootstrapping/gi, cleanedTopic)
            .replace(/the market size/gi, `the market size for "${cleanedTopic}"`)
            .replace(/solve actual bottlenecks/gi, `solve actual bottlenecks around "${cleanedTopic}"`);
  });
};

// ----------------------------------------------------
// AI GENERATION PROXY ENDPOINT
// ----------------------------------------------------
const parseVariations = (text) => {
  const variations = [];
  const parts = text.split(/VARIATION\s*\d+\s*:/i);
  if (parts.length > 1) {
    for (let i = 1; i < parts.length; i++) {
      const p = parts[i].trim();
      if (p) variations.push(p);
    }
  }
  
  if (variations.length < 3) {
    const listParts = text.split(/(?:^|\n)(?:\d+\.|\bVARIATION\s+\d+\b|\[\d+\])\s*/i);
    const cleaned = listParts.map(p => p.trim()).filter(Boolean);
    if (cleaned.length >= 3) {
      return cleaned.slice(0, 3);
    }
  }
  
  if (variations.length < 3) {
    const paras = text.split(/\n\s*\n/).map(p => p.trim()).filter(p => p.length > 10);
    if (paras.length >= 3) {
      return paras.slice(0, 3);
    } else if (paras.length > 0) {
      return [
        paras[0] || "Draft 1",
        paras[1] || "Draft 2",
        paras[2] || "Draft 3"
      ];
    }
  }
  return variations.slice(0, 3);
};

app.post('/api/generate', authenticateToken, async (req, res) => {
  const { topic, style } = req.body;
  const user = req.user;

  if (!topic || !style) {
    return res.status(400).json({ error: 'Topic and style are required' });
  }

  // Check generation quota limit
  const currentCount = user.postsGenerated || 0;
  if (currentCount >= 5) {
    return res.status(403).json({ error: 'You have exhausted your remaining post drafts. Please upgrade your plan.' });
  }

  // Resolve API Provider configuration:
  // Order of precedence:
  // 1. User profile custom provider settings
  // 2. Server-wide environment keys (.env)
  // 3. Fallback to demo mode
  let activeProvider = user.apiProvider || 'demo';
  let activeKey = user.apiKey || '';
  let activeModel = user.model || 'claude-haiku-4-5';
  let activeEndpoint = user.apiEndpoint || 'https://api.anthropic.com/v1/messages';

  // Override to server key defaults if user has not configured a custom key
  if (!activeKey) {
    if (process.env.CLAUDE_API_KEY && (activeProvider === 'anthropic' || activeProvider === 'demo')) {
      activeProvider = 'anthropic';
      activeKey = process.env.CLAUDE_API_KEY;
      activeModel = 'claude-3-5-haiku-20241022';
    } else if (process.env.OPENROUTER_API_KEY && (activeProvider === 'openrouter' || activeProvider === 'demo')) {
      activeProvider = 'openrouter';
      activeKey = process.env.OPENROUTER_API_KEY;
      activeModel = 'anthropic/claude-3-5-haiku';
    } else if (process.env.GROQ_API_KEY && (activeProvider === 'groq' || activeProvider === 'demo')) {
      activeProvider = 'groq';
      activeKey = process.env.GROQ_API_KEY;
      activeModel = 'llama-3.3-70b-versatile';
    } else if (activeProvider === 'ollama') {
      activeKey = 'ollama_no_key_required';
    }
  }

  try {
    const styleDescriptions = {
      storytelling: "Personal story with a lesson",
      insight: "3-5 sharp non-obvious points",
      contrarian: "Challenge the common wisdom",
      howto: "Step-by-step practical guide"
    };

    const userSamples = user.samples || [];
    const promptSystem = `You are a LinkedIn ghostwriter for an Indian founder or professional. \n\nTheir writing style is based on these sample posts they have written:\n${userSamples.map((s, i) => `Sample post ${i + 1}:\n${s}`).join('\n\n')}\n\nAnalyse their tone, sentence length, vocabulary, and how they open posts. Then write new posts that sound exactly like them.\n\nRULES - never break these:\n- Never use: game-changer, leverage, synergy, excited to share, thrilled, humbled\n- Never open with 'I am...' or 'Today I want to...'\n- Never end with 'What do you think?' or 'Drop a comment below'\n- No more than 2 hashtags per post\n- Write in first person\n- Sound like a real human, not AI\n- Target audience: Indian founders and startup professionals\n\nGenerate exactly 3 post variations. Format like this:\n\nVARIATION 1:\n[post text]\n\nVARIATION 2:\n[post text]\n\nVARIATION 3:\n[post text]\n\nEach post: 150-250 words. No emojis. Each starts with a completely different hook.`;
    const userPromptContent = `Style: ${style} (${styleDescriptions[style]})\nTopic: ${topic}\n\nGenerate the 3 variations.`;

    let drafts = [];

    if (activeProvider === 'demo' || !activeKey) {
      // Mock generation delay and results
      await new Promise(resolve => setTimeout(resolve, 3500));
      drafts = generateDemoDrafts(topic, style, userSamples);
    } else if (activeProvider === 'anthropic') {
      const response = await fetch(activeEndpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': activeKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: activeModel,
          max_tokens: 2500,
          system: promptSystem,
          messages: [
            {
              role: 'user',
              content: userPromptContent
            }
          ]
        })
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        const message = errData.error?.message || `HTTP error ${response.status}`;
        throw new Error(message);
      }

      const resData = await response.json();
      const responseText = resData.content?.[0]?.text || '';
      drafts = parseVariations(responseText);

      if (drafts.length < 3) {
        throw new Error("Failed to parse three variations from Claude output. Please retry.");
      }
    } else if (activeProvider === 'openrouter') {
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${activeKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: activeModel,
          messages: [
            {
              role: 'system',
              content: promptSystem
            },
            {
              role: 'user',
              content: userPromptContent
            }
          ]
        })
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        const message = errData.error?.message || `HTTP error ${response.status}`;
        throw new Error(message);
      }

      const resData = await response.json();
      const responseText = resData.choices?.[0]?.message?.content || '';
      drafts = parseVariations(responseText);

      if (drafts.length < 3) {
        throw new Error("Failed to parse three variations from OpenRouter output. Please retry.");
      }
    } else if (activeProvider === 'groq') {
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${activeKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: activeModel || 'llama-3.3-70b-versatile',
          messages: [
            {
              role: 'system',
              content: promptSystem
            },
            {
              role: 'user',
              content: userPromptContent
            }
          ]
        })
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        const message = errData.error?.message || `HTTP error ${response.status}`;
        throw new Error(message);
      }

      const resData = await response.json();
      const responseText = resData.choices?.[0]?.message?.content || '';
      drafts = parseVariations(responseText);

      if (drafts.length < 3) {
        throw new Error("Failed to parse three variations from Groq output. Please retry.");
      }
    } else if (activeProvider === 'ollama') {
      const ollamaHost = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
      const response = await fetch(`${ollamaHost}/api/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: activeModel || 'llama3',
          messages: [
            {
              role: 'system',
              content: promptSystem
            },
            {
              role: 'user',
              content: userPromptContent
            }
          ],
          stream: false
        })
      });

      if (!response.ok) {
        throw new Error(`Ollama HTTP error ${response.status}. Make sure Ollama is running and model is pulled.`);
      }

      const resData = await response.json();
      const responseText = resData.message?.content || '';
      drafts = parseVariations(responseText);

      if (drafts.length < 3) {
        throw new Error("Failed to parse three variations from Ollama output. Please retry.");
      }
    }

    // Save to database
    const newGenCount = currentCount + 1;
    const newHistoryItem = {
      id: 'gen_' + Date.now(),
      topic: topic.trim(),
      style: style,
      timestamp: Date.now(),
      drafts: drafts
    };

    const updatedHistory = [newHistoryItem, ...(user.history || [])];
    await db.updateUser(user.email, {
      postsGenerated: newGenCount,
      history: updatedHistory
    });

    res.json({
      drafts,
      postsGenerated: newGenCount
    });

  } catch (error) {
    console.error("Server API Generation error:", error);
    let errorMsg = error.message || 'unknown error';
    if (activeProvider === 'ollama' && (errorMsg.toLowerCase().includes('fetch failed') || errorMsg.includes('ECONNREFUSED'))) {
      errorMsg = 'Could not connect to your local Ollama server. Please ensure Ollama is open and running on your computer, and that you have downloaded the model by running "ollama run llama3" in your terminal.';
    }
    res.status(500).json({ error: `Generation failed: ${errorMsg}` });
  }
});

// ----------------------------------------------------
// OLLAMA AUTOMATED PIPELINE ENDPOINTS
// ----------------------------------------------------
function startOllama() {
  console.log('Attempting to launch Ollama background process...');
  // Spawns "ollama serve" in a Windows command window in the background
  const child = exec('ollama serve', { shell: true }, (error) => {
    if (error) {
      console.error('Ollama serve startup failed:', error);
    }
  });
  child.unref();
}

async function isOllamaRunning(ollamaHost) {
  try {
    const res = await fetch(ollamaHost, { method: 'HEAD' });
    return res.status === 200 || res.status === 404 || res.status === 405;
  } catch (e) {
    return false;
  }
}

app.get('/api/ollama/status', async (req, res) => {
  const ollamaHost = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
  const model = req.query.model || 'llama3';

  let running = await isOllamaRunning(ollamaHost);
  if (!running) {
    startOllama();
    // Wait for server to start listening
    await new Promise(resolve => setTimeout(resolve, 2500));
    running = await isOllamaRunning(ollamaHost);
  }

  if (!running) {
    return res.json({ running: false, installed: false });
  }

  try {
    const tagsRes = await fetch(`${ollamaHost}/api/tags`);
    if (tagsRes.ok) {
      const tagsData = await tagsRes.json();
      const modelsList = tagsData.models || [];
      const installed = modelsList.some(m => 
        m.name.toLowerCase() === model.toLowerCase() || 
        m.name.toLowerCase() === `${model.toLowerCase()}:latest` ||
        m.model.toLowerCase() === model.toLowerCase()
      );
      return res.json({ running: true, installed });
    }
  } catch (err) {
    console.error("Failed to fetch tags from Ollama:", err);
  }

  res.json({ running: true, installed: false });
});

app.post('/api/ollama/pull', async (req, res) => {
  const ollamaHost = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
  const { model } = req.body;
  if (!model) return res.status(400).json({ error: 'Model name is required' });

  try {
    console.log(`Starting automated pull of model: ${model}`);
    const pullRes = await fetch(`${ollamaHost}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: model, stream: false })
    });

    if (pullRes.ok) {
      return res.json({ success: true });
    } else {
      const errText = await pullRes.text();
      return res.status(500).json({ error: `Ollama pull failed: ${errText}` });
    }
  } catch (err) {
    res.status(500).json({ error: `Ollama pull connection failed: ${err.message}` });
  }
});

// Start Server
app.listen(PORT, () => {
  console.log(`LinkedCraft backend server running on http://localhost:${PORT}`);
});
