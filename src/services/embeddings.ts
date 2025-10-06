import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");
export const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

// Simple cache to avoid repeated API calls
const embeddingCache = new Map<string, number[]>();

// Delay function for retries
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Fallback embedding generator
function generateFallbackEmbedding(text: string): number[] {
  const hash = text.split("").reduce((a, b) => {
    a = (a << 5) - a + b.charCodeAt(0);
    return a & a;
  }, 0);

  // Generate a 768-dimensional vector
  return new Array(768)
    .fill(0)
    .map((_, i) => Math.sin(hash * (i + 1) * 0.001) * 0.1);
}

export async function getEmbedding(text: string): Promise<number[]> {
  // Check cache first
  const cachedEmbedding = embeddingCache.get(text);
  if (cachedEmbedding) {
    console.log("Using cached embedding");
    return cachedEmbedding;
  }

  const MAX_EMBEDDING_SIZE = 30000; // Conservative limit in bytes

  const getEmbeddingWithRetry = async (
    textToEmbed: string,
    retries = 1
  ): Promise<number[]> => {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const embeddingModel = genAI.getGenerativeModel({
          model: "gemini-embedding-001",
        });
        const result = await embeddingModel.embedContent({
          content: {
            role: "user",
            parts: [{ text }],
          },
          taskType: "retrieval_document", // ✅ just a string
          outputDimensionality: 768, // ✅ works at runtime, cast fixes TS
        } as any);

        if (result.embedding && typeof result.embedding === "object") {
          if (
            "values" in result.embedding &&
            Array.isArray(result.embedding.values)
          ) {
            return result.embedding.values;
          } else if (Array.isArray(result.embedding)) {
            return result.embedding;
          }
        }

        console.error("Unexpected embedding format:", result.embedding);
        throw new Error("Failed to get valid embedding");
      } catch (error: any) {
        if (error.status === 429) {
          if (attempt < retries) {
            const waitTime = Math.pow(2, attempt) * 1000 + Math.random() * 1000;
            console.log(
              `Rate limited. Waiting ${waitTime}ms before retry ${
                attempt + 1
              }/${retries}`
            );
            await delay(waitTime);
            continue;
          } else {
            console.warn("API quota exceeded. Using fallback embedding.");
            return generateFallbackEmbedding(textToEmbed);
          }
        }
        throw error;
      }
    }
    throw new Error("Max retries exceeded");
  };

  let finalEmbedding: number[];

  // If text is already within limits, use it directly
  if (text.length <= MAX_EMBEDDING_SIZE) {
    try {
      finalEmbedding = await getEmbeddingWithRetry(text);
    } catch (error: any) {
      if (error.message?.includes("quota") || error.status === 429) {
        console.warn("Quota exceeded, using fallback embedding");
        finalEmbedding = generateFallbackEmbedding(text);
      } else {
        throw error;
      }
    }
  } else {
    // For larger text, summarize it first
    try {
      // Aggressive summarization using the model
      const summary = await model.generateContent({
        contents: [
          {
            role: "user",
            parts: [
              {
                text: `Create a concise summary (under 5000 characters) that captures the essential meaning and key concepts of this text. Focus on the most important ideas only: ${text.substring(
                  0,
                  25000
                )}...`,
              },
            ],
          },
        ],
      });

      const summarizedText = summary.response?.text() || "";

      // If summary is still too long, truncate it
      const finalText =
        summarizedText.length > MAX_EMBEDDING_SIZE
          ? summarizedText.substring(0, MAX_EMBEDDING_SIZE)
          : summarizedText;

      // Get embedding of the summarized text
      try {
        finalEmbedding = await getEmbeddingWithRetry(finalText);
      } catch (error: any) {
        if (error.message?.includes("quota") || error.status === 429) {
          console.warn("Quota exceeded, using fallback embedding");
          finalEmbedding = generateFallbackEmbedding(finalText);
        } else {
          throw error;
        }
      }
    } catch (error) {
      console.error("Error during summarization or embedding:", error);

      // Fallback: simple truncation if summarization fails
      const truncatedText = text.substring(0, MAX_EMBEDDING_SIZE);
      try {
        finalEmbedding = await getEmbeddingWithRetry(truncatedText);
      } catch (embeddingError: any) {
        if (
          embeddingError.message?.includes("quota") ||
          embeddingError.status === 429
        ) {
          console.warn("Quota exceeded, using fallback embedding");
          finalEmbedding = generateFallbackEmbedding(truncatedText);
        } else {
          throw embeddingError;
        }
      }
    }
  }

  // Cache the result
  embeddingCache.set(text, finalEmbedding);
  return finalEmbedding;
}
