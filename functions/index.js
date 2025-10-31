const functions = require("firebase-functions");
const admin = require("firebase-admin");
// Import MongoDB Driver
const { MongoClient, ServerApiVersion } = require("mongodb");

// Correct import for Gemini
const { GoogleGenerativeAI } = require("@google/generative-ai");

// Initialize Firebase Admin SDK ONLY ONCE
if (admin.apps.length === 0) {
    admin.initializeApp();
}

// --- MongoDB Configuration ---
// IMPORTANT: Set MongoDB connection string securely using Firebase config
// In your terminal, run:
// firebase functions:config:set mongodb.uri="mongodb+srv://YOUR_USER:YOUR_PASSWORD@..."
let mongoClient;
let mongoDb;
const mongoUri = functions.config().mongodb.uri;
const dbName = "innovantaDB"; // Your database name in Atlas
const collectionName = "analysisReports"; // Collection to store results

// Function to establish MongoDB connection (reusable)
async function connectToMongo() {
    if (mongoClient && mongoClient.topology && mongoClient.topology.isConnected()) {
        console.log("Using existing MongoDB connection.");
        return mongoDb;
    }
    if (!mongoUri) {
        throw new Error("MongoDB URI not found in Firebase Functions config. Set using 'firebase functions:config:set mongodb.uri=...'");
    }
    console.log("Attempting to connect to MongoDB Atlas...");
    mongoClient = new MongoClient(mongoUri, {
        serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true }
    });
    try {
        await mongoClient.connect();
        mongoDb = mongoClient.db(dbName);
        console.log("Successfully connected to MongoDB Atlas!");
        return mongoDb;
    } catch (e) {
        console.error("CRITICAL ERROR: Failed to connect to MongoDB Atlas.", e);
        if (mongoClient) { await mongoClient.close(); mongoClient = null; mongoDb = null; }
        throw e;
    }
}

// --- Gemini AI Configuration ---
// IMPORTANT: Set Gemini API Key securely using Firebase config
// firebase functions:config:set gemini.key="YOUR_SECRET_GEMINI_API_KEY"
let genAI;
try {
    const geminiApiKey = functions.config().gemini.key;
    if (!geminiApiKey) {
        throw new Error("Gemini API Key not found in Firebase Functions config. Set using 'firebase functions:config:set gemini.key=...'");
    }
    genAI = new GoogleGenerativeAI(geminiApiKey);
    console.log("Gemini AI Initialized.");
} catch (e) {
    console.error("CRITICAL ERROR: Failed to initialize GoogleGenerativeAI.", e);
}

// System instruction for the AI (Use your full prompt)
const systemPrompt = `You are a world-class SME Financial and Business Analyst. Your task is to process the following raw CSV data and return a detailed, professional business report. The response must be structured using Markdown.

The report should contain the following five sections, using the data provided:
1. EXECUTIVE SUMMARY: A single paragraph summarizing the key trends and overall health.
2. ACTIONABLE INSIGHTS: Provide 5 clear, numbered, and specific recommendations to boost efficiency and ROI based on the data. Use standard markdown list format (* item).
3. KEY PERFORMANCE INDICATORS (KPIs) & TRENDS: Calculate and present 3-4 key growth metrics (e.g., total profit, average revenue/customer, profit margin percentage) and describe a clear trend (positive/negative) for each. Use standard markdown list format (* item).
4. ROI & FORECAST: Provide a short forecast (2-3 sentences) based on current performance AND explicitly state a 'Projected ROI %' as a number followed by '%'.
5. CRITICAL ALERTS: List any critical issues found (e.g., * High Customer Churn Rate). If none, state explicitly "No Critical Alerts Detected." Use standard markdown list format (* item).
`;

// --- Callable Cloud Function ---
// This function is called directly from the frontend (app.html)
exports.analyzeCsvContent = functions.https.onCall(async (data, context) => {
    // 1. Authentication Check
    if (!context.auth) {
        console.error("Function called without authentication.");
        throw new functions.https.HttpsError('unauthenticated', 'The function must be called while authenticated.');
    }
    const userId = context.auth.uid;
    console.log(`Received analysis request from authenticated user: ${userId}`);

    // 2. Input Validation
    const { fileContent, fileName } = data;
    if (!fileContent || typeof fileContent !== 'string' || fileContent.trim() === "") {
        console.error("Invalid argument: fileContent missing or empty.");
        throw new functions.https.HttpsError('invalid-argument', 'The function must be called with a non-empty "fileContent" string.');
    }
     if (!fileName || typeof fileName !== 'string') {
        console.error("Invalid argument: fileName missing or not a string.");
        throw new functions.https.HttpsError('invalid-argument', 'The function must be called with a "fileName" string.');
    }
    console.log(`Received file: ${fileName}, Content length: ${fileContent.length}`);

    // 3. Ensure AI and DB Services are Ready
    if (!genAI) {
        console.error("analyzeCsvContent function cannot run: GoogleGenerativeAI failed to initialize.");
        throw new functions.https.HttpsError('internal', 'AI Service Initialization Failed. Contact support.');
    }
     let currentDb;
     try {
         currentDb = await connectToMongo();
     } catch(mongoError) {
          console.error("analyzeCsvContent function cannot run: MongoDB connection failed.", mongoError);
          throw new functions.https.HttpsError('internal', 'Database connection failed. Contact support.');
     }

    // 4. Prepare Initial Record for MongoDB
    const analysisRecord = {
        userId: userId,
        fileName: fileName,
        status: "processing",
        createdAt: new Date(),
        report: null,
        error: null
    };
    const reportsCollection = currentDb.collection(collectionName);
    let mongoDocId;

    try {
        // 5. Save initial request state to MongoDB
        const insertResult = await reportsCollection.insertOne(analysisRecord);
        mongoDocId = insertResult.insertedId;
        console.log(`Initial analysis record created in MongoDB with ID: ${mongoDocId}`);

        // 6. Prepare AI Prompt
        console.log("Preparing prompt for Gemini API...");
        // Use gemini-1.5-flash which supports system instructions well
        const model = genAI.getGenerativeModel({
            model: "gemini-1.5-flash",
             systemInstruction: systemPrompt // Pass system prompt here
        });
        const userQuery = `\n\nRAW CSV DATA START:\n${fileContent}\nRAW CSV DATA END`;

        // 7. Call Gemini API
        console.log("Calling Gemini API...");
        const result = await model.generateContent(userQuery); // Send only user query

        // Updated check for response structure with gemini-1.5-flash
        if (!result.response || !result.response.candidates || !result.response.candidates[0]?.content?.parts?.[0]?.text) {
             console.error("Invalid response structure from Gemini API:", JSON.stringify(result.response, null, 2));
             throw new Error("AI analysis returned an invalid or empty response structure.");
         }
        const reportText = result.response.candidates[0].content.parts[0].text;
        console.log("AI analysis successful. Report length:", reportText.length);

        // 8. Update MongoDB record with success
        console.log(`Updating MongoDB record ${mongoDocId} with completed report.`);
        const updateResult = await reportsCollection.updateOne(
            { _id: mongoDocId },
            { $set: { status: "completed", report: reportText, lastUpdated: new Date() } }
        );
         if (updateResult.modifiedCount !== 1) {
             console.warn(`MongoDB update might not have fully completed for ${mongoDocId}. Modified count: ${updateResult.modifiedCount}`);
         }

        // 9. Return success and the report to the frontend
         console.log(`Analysis complete for ${mongoDocId}. Returning report.`);
        return {
             status: "completed",
             reportId: mongoDocId.toString(),
             report: reportText,
             fileName: fileName,
             createdAt: analysisRecord.createdAt
        };

    } catch (err) {
        // Centralized error handling
        console.error(`Error during AI analysis or DB operations for user ${userId}, file ${fileName}, (potential MongoDB ID: ${mongoDocId}):`, err);
        const errorMessage = err.message || 'Unknown error during analysis.';
        if (mongoDocId) {
            try {
                await reportsCollection.updateOne(
                    { _id: mongoDocId },
                    { $set: { status: "error", error: errorMessage, lastUpdated: new Date() } }
                );
                 console.log(`MongoDB record ${mongoDocId} updated with error status.`);
            } catch (mongoError) {
                 console.error(`Failed to update MongoDB record ${mongoDocId} with error status after primary failure:`, mongoError);
            }
        } else {
            console.error("Could not record error status to MongoDB because initial insert failed or ID was not obtained.");
        }
        throw new functions.https.HttpsError('internal', `AI Analysis Failed: ${errorMessage}`);
    }
});

