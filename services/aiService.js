/**
 * AI Service Layer for LinkedCraft AI LinkedIn Growth Agent
 * Powered by Google Gemini 2.5 Flash API
 */

const fetch = globalThis.fetch;

// Helper to interact with the Gemini 2.5 Flash API
async function callGemini(systemInstruction, userPrompt, apiKeyOverride = '') {
  const apiKey = apiKeyOverride || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('Google Gemini API Key is missing. Please set GEMINI_API_KEY in your environment or configuration.');
  }

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

  const requestBody = {
    contents: [
      {
        parts: [
          {
            text: userPrompt
          }
        ]
      }
    ],
    systemInstruction: {
      parts: [
        {
          text: systemInstruction
        }
      ]
    },
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 2548
    }
  };

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      const errMsg = errData.error?.message || `HTTP status ${response.status}`;
      throw new Error(`Gemini API call failed: ${errMsg}`);
    }

    const resData = await response.json();
    const candidate = resData.candidates?.[0];
    const text = candidate?.content?.parts?.[0]?.text || '';
    if (!text) {
      throw new Error('Gemini API returned an empty response.');
    }
    return text.trim();
  } catch (error) {
    console.error('aiService: callGemini error:', error);
    throw error;
  }
}

/**
 * Generate 3 variations of LinkedIn drafts based on a topic, style, user memory, and voice samples.
 */
async function generatePosts(topic, style, userMemory = {}, voiceSamples = [], apiKeyOverride = '') {
  const { niche = '', industry = '', targetAudience = '', writingStyle = '', contentGoals = '' } = userMemory;
  
  const styleDescriptions = {
    storytelling: "Personal story with a lesson and hook",
    insight: "3-5 sharp, non-obvious analytical bullet points",
    contrarian: "Challenge standard industry wisdom or popular trends",
    howto: "Step-by-step practical, actionable guide"
  };

  const selectedDesc = styleDescriptions[style] || styleDescriptions.storytelling;

  // Build style guidelines from voice samples
  const samplesSection = voiceSamples.length > 0 
    ? `Analyze and replicate the exact writing style, sentence structure, hook length, and rhythm of these sample posts:\n${voiceSamples.map((s, idx) => `Sample ${idx + 1}:\n"${s}"`).join('\n\n')}`
    : `Use a professional yet highly authentic, conversational, and direct tone.`;

  const systemInstruction = `You are an elite LinkedIn ghostwriter and personal branding growth expert.
You write posts that sound 100% human, highly authentic, and tailored specifically for LinkedIn engagement.

USER PROFILE MEMORY:
- Niche: ${niche}
- Industry: ${industry}
- Target Audience: ${targetAudience}
- Writing Style Preferences: ${writingStyle}
- Goals: ${contentGoals}

${samplesSection}

STRICT WRITING RULES:
- Never use generic AI fluff or buzzwords: game-changer, leverage, synergy, excited to share, thrilled, humbled, key takeaways, look no further, dive in.
- Do NOT start with greeting words or phrases like "I am...", "Today I want to...", "Here is my story...". Jump straight into the hook.
- Do NOT use emojis.
- Do NOT ask "What do you think?" or "Drop a comment below" at the end of the post.
- Keep sentences punchy, short, and varied in length.
- Add at most 2 relevant hashtags at the very end.
- Sound like a real practitioner writing from direct, boots-on-the-ground experience.

Format your response EXACTLY as follows:
VARIATION 1:
[Insert post text here, between 120 and 250 words]

VARIATION 2:
[Insert post text here, between 120 and 250 words]

VARIATION 3:
[Insert post text here, between 120 and 250 words]`;

  const userPrompt = `Generate 3 distinct drafts about: "${topic}"
Style required: ${style} (${selectedDesc}).
Focus on hooks that are different for each variation.`;

  const rawResult = await callGemini(systemInstruction, userPrompt, apiKeyOverride);
  return rawResult;
}

/**
 * ChatGPT-style iterative agent. Rewrites a post based on specific instructions.
 */
async function rewritePost(postText, instruction, userMemory = {}, apiKeyOverride = '') {
  const { niche = '', industry = '', targetAudience = '', writingStyle = '', contentGoals = '' } = userMemory;

  const systemInstruction = `You are an expert LinkedIn growth editor.
Analyze the user's post and rewrite it according to their instructions. Preserve the original core idea but adjust structure, hook, style, or format as requested.

USER PROFILE MEMORY:
- Niche: ${niche}
- Industry: ${industry}
- Target Audience: ${targetAudience}
- Writing Style: ${writingStyle}
- Goals: ${contentGoals}

RULES:
- Do NOT include markdown styling like triple backticks or conversational filler (e.g. "Sure! Here is the revised post:").
- Output ONLY the rewritten post directly.
- Maintain a natural, punchy, human tone. Avoid AI clichés (excited to share, leverage, game-changer).
- Keep length under 250 words unless the instruction specifically requests a long-form article.`;

  const userPrompt = `ORIGINAL POST:
${postText}

EDIT/REWRITE INSTRUCTION:
${instruction}

Provide the updated post now.`;

  return await callGemini(systemInstruction, userPrompt, apiKeyOverride);
}

/**
 * Generate a content calendar schedule (e.g., 7 days or 30 days) in a clean JSON format.
 */
async function generateCalendar(durationDays = 7, userMemory = {}, apiKeyOverride = '') {
  const { niche = 'Technology & SaaS', industry = 'Software', targetAudience = 'Startup Founders', writingStyle = 'Direct & Storytelling', contentGoals = 'Brand awareness' } = userMemory;

  const systemInstruction = `You are a strategic LinkedIn Growth planner.
Create a content plan for the next ${durationDays} days.
The response must be valid JSON matching the format below.
Do not include any conversational preamble, notes, or triple backticks (\`\`\`). Output raw JSON only.

USER PROFILE MEMORY:
- Niche: ${niche}
- Industry: ${industry}
- Target Audience: ${targetAudience}
- Style: ${writingStyle}
- Goals: ${contentGoals}

JSON Format:
[
  {
    "day": 1,
    "topic": "Brief summary of the post's core message",
    "style": "storytelling",
    "scheduledTime": "09:00",
    "postText": "Full drafted post text following the writing style guidelines, ready to be approved. Keep it punchy, human, and direct. 100-200 words. No emojis."
  },
  ...
]`;

  const userPrompt = `Generate a ${durationDays}-day content plan for a profile in the niche: "${niche}" targeting "${targetAudience}".`;

  const rawJson = await callGemini(systemInstruction, userPrompt, apiKeyOverride);
  
  // Clean JSON wrap if Gemini includes markdown quotes
  let cleaned = rawJson.trim();
  if (cleaned.startsWith('```json')) {
    cleaned = cleaned.slice(7);
  }
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.slice(3);
  }
  if (cleaned.endsWith('```')) {
    cleaned = cleaned.slice(0, -3);
  }
  cleaned = cleaned.trim();

  try {
    return JSON.parse(cleaned);
  } catch (err) {
    console.error("aiService: generateCalendar failed to parse JSON, raw text was:", rawJson);
    throw new Error("Failed to generate a clean, parseable content plan. Please retry.");
  }
}

/**
 * Analyze a LinkedIn profile/feed to provide growth insights and specific feedback.
 */
async function analyzeProfile(profileSummary, recentPosts = [], apiKeyOverride = '') {
  const systemInstruction = `You are an elite personal brand strategist.
Analyze the user's profile summary and recent posts, then provide a detailed audit containing:
1. Strengths (What works well in their current content)
2. Growth Opportunities (Areas of improvement for distribution, hooks, or formatting)
3. 3 Strategic Content Pillars they should focus on
4. Suggested profile tagline/headline optimization

Output the response in clean Markdown.`;

  const userPrompt = `PROFILE DETAILS:
${profileSummary}

RECENT POSTS:
${JSON.stringify(recentPosts)}

Provide the growth audit now.`;

  return await callGemini(systemInstruction, userPrompt, apiKeyOverride);
}

/**
 * Suggest 3 value-adding networking comments for a user to write on a target post.
 */
async function suggestComments(postText, userMemory = {}, apiKeyOverride = '') {
  const { niche = '', industry = '', writingStyle = '' } = userMemory;

  const systemInstruction = `You are a professional networker.
Provide 3 distinct, authentic comment templates the user can use to reply to the target post.
Each comment must add actual value, present a point of view, share a mini-insight, or ask a clarifying question.
Do not sound sycophantic ("Great post!", "Fully agree!"). Avoid corporate jargon.

USER PROFILE MEMORY:
- Niche: ${niche}
- Industry: ${industry}
- Tone style: ${writingStyle}

Format:
COMMENT 1:
[text]

COMMENT 2:
[text]

COMMENT 3:
[text]`;

  const userPrompt = `TARGET POST CONTENT:
${postText}

Suggest 3 natural, high-value comments.`;

  return await callGemini(systemInstruction, userPrompt, apiKeyOverride);
}

/**
 * Interactive ChatGPT-style chatbot method.
 */
async function chatWithAgent(history, userMemory = {}, apiKeyOverride = '') {
  const { niche = '', industry = '', targetAudience = '', writingStyle = '', contentGoals = '' } = userMemory;

  const systemInstruction = `You are LinkedCraft, a premium conversational LinkedIn Growth Agent.
Your role is to help the user ideate, draft, refine, plan, or structure their LinkedIn presence.
You talk like an experienced, highly helpful, elite founder ghostwriter and brand strategist.

USER PROFILE MEMORY (This is what you know about the user):
- Niche: ${niche}
- Industry: ${industry}
- Target Audience: ${targetAudience}
- Writing Style: ${writingStyle}
- Goals: ${contentGoals}

RULES:
- When asked to write a post, follow the profile memory and voice sample tone guidelines. Avoid AI buzzwords (game-changer, excited to share, leverage, synergy, humbled).
- Keep your conversational responses concise, strategic, and professional.
- Do not output generic greetings or generic advice. Be extremely direct and actionable.
- Support iterative changes: if they say "make it more controversial", "convert to a founder story", "suggest comments", perform the edit exactly.
- Keep output nicely formatted using markdown.`;

  // We map the incoming history to Gemini REST API contents structure
  const contents = history.map(msg => ({
    role: msg.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: msg.content }]
  }));

  const apiKey = apiKeyOverride || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('Google Gemini API Key is missing. Please set GEMINI_API_KEY.');
  }

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

  const requestBody = {
    contents,
    systemInstruction: {
      parts: [{ text: systemInstruction }]
    },
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 2048
    }
  };

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const errData = await response.json().catch(() => ({}));
    const errMsg = errData.error?.message || `HTTP status ${response.status}`;
    throw new Error(`Gemini API call failed: ${errMsg}`);
  }

  const resData = await response.json();
  const candidate = resData.candidates?.[0];
  const text = candidate?.content?.parts?.[0]?.text || '';
  return text.trim();
}

module.exports = {
  generatePosts,
  rewritePost,
  generateCalendar,
  analyzeProfile,
  suggestComments,
  chatWithAgent
};
