const { GoogleGenAI } = require('@google/genai');

// The Vercel environment variable GEMINI_API_KEY must be set in the Vercel dashboard.
const ai = new GoogleGenAI(process.env.GEMINI_API_KEY);

// System instruction for the AI, giving it a persona
const systemPrompt = `You are a world-class SME Financial and Business Analyst. Your task is to process the following raw CSV data and return a detailed, professional business report. The response must be structured using Markdown.

The report should contain the following four sections, using the data provided:
1. EXECUTIVE SUMMARY: A single paragraph summarizing the key trends and overall health.
2. ACTIONABLE INSIGHTS: Provide 5 clear, numbered, and specific recommendations to boost efficiency and ROI based on the data.
3. KEY PERFORMANCE INDICATORS (KPIs) & TRENDS: Calculate and present 3-4 key growth metrics (e.g., total profit, average revenue/customer, profit margin percentage) and describe a clear trend (positive/negative) for each.
4. ROI & FORECAST: Provide a short forecast (2-3 sentences) based on current performance.
`;

module.exports = async (req, res) => {
    // Vercel function should only respond to POST requests
    if (req.method !== 'POST') {
        return res.status(405).send({ message: 'Only POST requests allowed.' });
    }

    try {
        const { fileContent } = req.body;

        if (!fileContent) {
            return res.status(400).send({ message: 'Missing file content in request body.' });
        }

        // Prepare the content parts for the Gemini API
        const parts = [
            { text: systemPrompt },
            { text: `\nRAW CSV DATA START:\n${fileContent}\nRAW CSV DATA END` }
        ];

        // Call the Gemini API securely
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash-preview-09-2025',
            contents: [{ role: "user", parts: parts }]
        });

        const reportText = response.candidates?.[0]?.content?.parts?.[0]?.text || "AI analysis failed to generate a report.";

        // Send the generated report back to the client
        res.status(200).json({ report: reportText });

    } catch (error) {
        console.error("AI Analysis Error:", error.message);
        res.status(500).send({ message: `AI analysis failed due to a server error. Check GEMINI_API_KEY setting.`, details: error.message });
    }
};
