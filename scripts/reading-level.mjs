import { GoogleGenAI, Type } from '@google/genai';

const DEFAULT_MODEL = 'gemini-4-hydrogen';
const DEPRECATED_MODELS = new Set([
  'gemini-1.5-flash',
  'gemini-1.5-pro',
  'gemini-pro',
  'gemini-2.0-flash',
  'gemini-2.0-pro',
  'gemini-2.0-flash-thinking',
  'gemini-3.5-flash-lite',
]);

export function resolveModel(configuredModel) {
  if (!configuredModel || DEPRECATED_MODELS.has(configuredModel)) {
    return DEFAULT_MODEL;
  }
  return configuredModel;
}

export function getGeminiClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

// Baseline safety filter for mature/graphic topics unsuitable for 10-14 year old readers
const UNSAFE_PATTERNS = [
  /\b(murder|murdered|homicide|manslaughter|serial killer|behead|beheading)\b/i,
  /\b(rape|raped|sexual assault|molest|molestation|porn|pornography|explicit|nsfw)\b/i,
  /\b(suicide|self-harm|overdose)\b/i,
  /\b(mass shooting|terrorist attack|suicide bomber|genocide|torture)\b/i,
  /\b(cocaine|heroin|methamphetamine|fentanyl|drug cartel)\b/i,
  /\b(online casino|sports betting|gambling)\b/i,
];

export function isKidSafeBasic(article) {
  const text = `${article?.title || ''} ${article?.snippet || ''}`;
  return !UNSAFE_PATTERNS.some((re) => re.test(text));
}

// Clean up RSS feed boilerplate and keep snippets short and readable
export function cleanSnippetForKids(rawSnippet = '') {
  let text = String(rawSnippet || '')
    .replace(/\bThe post\s+.*?\s+appeared first on\s+.*$/i, '')
    .replace(/\[\u2026\]|\[\.\.\.\]/g, '...')
    .replace(/\s+/g, ' ')
    .trim();

  if (!text) return '';

  // Keep up to 2 complete sentences (or ~240 chars) for bite-sized reading
  const sentences = text.match(/[^.!?]+[.!?]+/g);
  if (sentences && sentences.length > 2) {
    text = sentences.slice(0, 2).join(' ').trim();
  }
  if (text.length > 260) {
    text = text.slice(0, 257).replace(/\s+\S*$/, '') + '...';
  }
  return text;
}

function tidyPlainText(text = '') {
  return String(text)
    .replace(/^#+\s.*$/gm, '')
    .replace(/[*_`#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function summariseSingleArticle(article, cfg = {}) {
  const ai = getGeminiClient();
  if (!ai) {
    throw new Error('GEMINI_API_KEY is not configured in Settings > Secrets.');
  }

  const prompt = cfg.summaryPrompt
    || 'Summarise this news article in 2 short, clear sentences for a 10-14 year old reader. Use simple everyday words, keep it strictly kid-safe, and use only facts in the text below. Plain text only: no headings, no bullet points, no emojis.';

  const response = await ai.models.generateContent({
    model: resolveModel(cfg.model),
    contents: `${prompt}\n\nTitle: ${article.title}\nText: ${article.snippet || article.title}`,
  });

  const tidy = tidyPlainText(response.text || '');
  if (!tidy) throw new Error('Gemini returned an empty summary.');
  return tidy;
}

/**
 * Filters articles for age 10-14 suitability and rewrites titles/summaries
 * to a 10-14 year old reading level via Gemini when GEMINI_API_KEY is available.
 */
export async function adaptArticlesForYoungReaders(articles, cfg = {}, maxBatch = 12) {
  const preFiltered = articles.filter(isKidSafeBasic).map((a) => ({
    ...a,
    snippet: cleanSnippetForKids(a.snippet),
  }));
  const preFilteredOut = articles.length - preFiltered.length;

  if (!cfg.aiSummaries) {
    return {
      articles: preFiltered,
      filteredCount: preFilteredOut,
      aiApplied: false,
      aiNotice: null,
      aiError: null,
    };
  }

  const ai = getGeminiClient();
  if (!ai) {
    return {
      articles: preFiltered,
      filteredCount: preFilteredOut,
      aiApplied: false,
      aiNotice: 'Kid-safety filter active. Add GEMINI_API_KEY in Settings > Secrets to rewrite new stories to a 10–14 reading level.',
      aiError: null,
    };
  }

  const batch = preFiltered.slice(0, maxBatch);
  const remainder = preFiltered.slice(maxBatch);
  if (batch.length === 0) {
    return {
      articles: [],
      filteredCount: preFilteredOut,
      aiApplied: true,
      aiNotice: null,
      aiError: null,
    };
  }

  try {
    const payload = batch.map((a, index) => ({
      index,
      title: a.title,
      text: a.snippet || a.title,
    }));

    const response = await ai.models.generateContent({
      model: resolveModel(cfg.model),
      contents: `Review and adapt these ${payload.length} news articles:\n\n${JSON.stringify(payload)}`,
      config: {
        systemInstruction: [
          'You are an editor for a news website read by 10 to 14 year olds (Grades 5-8).',
          'For every article in the input array, return one item with the matching index:',
          '- kidSafe: false if the article involves graphic violence, murder, sexual content/assault, suicide/self-harm, explicit crime, or mature adult-only themes unsuitable for ages 10-14; otherwise true.',
          '- adaptedTitle: rewrite only if needed so the headline is clear, factual, and easy for a 10-14 year old to understand (plain text, no emojis).',
          '- summary: write 2 short, engaging sentences at a 10-14 year old reading level explaining the main point using ONLY facts from the provided title and text (plain text only, no headings, no bullets, no emojis).',
        ].join('\n'),
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              index: { type: Type.INTEGER },
              kidSafe: { type: Type.BOOLEAN },
              adaptedTitle: { type: Type.STRING },
              summary: { type: Type.STRING },
            },
            required: ['index', 'kidSafe', 'adaptedTitle', 'summary'],
          },
        },
      },
    });

    const parsed = JSON.parse((response.text ?? '[]').trim());
    const byIndex = new Map(
      (Array.isArray(parsed) ? parsed : []).map((item) => [item.index, item])
    );

    const adapted = [];
    let aiFilteredOut = 0;

    batch.forEach((article, idx) => {
      const result = byIndex.get(idx);
      if (!result) {
        adapted.push(article);
        return;
      }
      if (result.kidSafe === false) {
        aiFilteredOut++;
        return;
      }
      const cleanTitle = tidyPlainText(result.adaptedTitle || article.title);
      const cleanSummary = tidyPlainText(result.summary || '');
      adapted.push({
        ...article,
        title: cleanTitle || article.title,
        summary: cleanSummary || article.summary || null,
      });
    });

    return {
      articles: [...adapted, ...remainder],
      filteredCount: preFilteredOut + aiFilteredOut,
      aiApplied: true,
      aiNotice: null,
      aiError: null,
    };
  } catch (err) {
    const rawMsg = String(err?.message || 'Gemini API request failed.');
    let friendlyError = rawMsg;
    if (/403|PERMISSION_DENIED|API_KEY_INVALID|400/i.test(rawMsg)) {
      friendlyError = 'Could not verify GEMINI_API_KEY. Please check your key in Settings > Secrets.';
    } else if (/429|RESOURCE_EXHAUSTED/i.test(rawMsg)) {
      friendlyError = 'Gemini API quota reached (429). Stories loaded with basic safety filtering.';
    } else if (/404|NOT_FOUND/i.test(rawMsg)) {
      friendlyError = 'Configured Gemini model was not found. Stories loaded with basic safety filtering.';
    }

    return {
      articles: preFiltered,
      filteredCount: preFilteredOut,
      aiApplied: false,
      aiNotice: null,
      aiError: friendlyError,
    };
  }
}
