import axios from 'axios';
import Lesson from '../models/Lesson.js';
import Enrollment from '../models/Enrollment.js';
import QuizAttempt from '../models/QuizAttempt.js';
import AIUsageLog from '../models/AIUsageLog.js';
import VectorService from '../services/vectorService.js';
import AIChatSession from '../models/AIChatSession.js';
import DoubtLog from '../models/DoubtLog.js';
import SimplifiedNote from '../models/SimplifiedNote.js';
import mammoth from 'mammoth';           // npm i mammoth
import pdfParse from 'pdf-parse';        // npm i pdf-parse
import Assignment from '../models/Assignment.js';
import Submission from '../models/Submission.js';
import LectureSummary from '../models/LectureSummary.js';
// import StudyPlan from '../models/StudyPlan.js';
// import GeneratedReport from '../models/GeneratedReport.js';
import mongoose from 'mongoose';
import { Exam, ExamAttempt } from '../models/Exam.js';
import { AUDIENCE_SCOPES, normalizeAudienceInput, validateAudience } from '../utils/audience.js';

const GROQ_API_KEY = process.env.GROQ_API_KEY;

// --- AI Usage Logging Helper ---
async function logAIUsage(userId, action, details = {}) {
    try {
        const user = await (await import('../models/User.js')).default.findById(userId);
        const instituteId = user?.instituteId || null;

        await AIUsageLog.create({ userId, instituteId, action, details });
    } catch (err) {
        console.error('AI usage log error:', err.message);
    }
}
// Helper function to call Groq AI
async function callGroqAI(prompt) {
    try {
        const res = await axios.post(
            'https://api.groq.com/openai/v1/chat/completions',
            {
                model: 'llama-3.3-70b-versatile',
                messages: [{ role: 'user', content: prompt }],
                max_tokens: 4000,
                temperature: 0.5,
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${GROQ_API_KEY}`,
                },
            }
        );

        return res.data.choices[0].message.content;
    } catch (error) {
        console.error('Groq AI error:', error.response?.data || error.message);
        throw new Error('AI generation failed');
    }
}

// Helper function to call OpenAI (gpt-4o-mini)
async function callOpenAI(prompt) {
    try {
        const res = await axios.post(
            'https://api.openai.com/v1/chat/completions',
            {
                model: 'gpt-4o-mini',
                messages: [{ role: 'user', content: prompt }],
                max_tokens: 4000,
                temperature: 0.5,
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
                },
            }
        );

        return res.data.choices[0].message.content;
    } catch (error) {
        console.error('OpenAI error:', error.response?.data || error.message);
        throw new Error('AI generation failed');
    }
}

// Helper function to call Groq AI with full messages array
async function callGroqAIChat(messages) {
    try {
        const res = await axios.post(
            'https://api.groq.com/openai/v1/chat/completions',
            {

                model: 'llama-3.3-70b-versatile',
                messages: messages,
                max_tokens: 4000,
                temperature: 0.7,
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${GROQ_API_KEY}`,
                },
            }
        );

        return res.data.choices[0].message.content;
    } catch (error) {
        console.error('Groq AI Chat error:', error.response?.data || error.message);
        throw new Error('AI Chat failed');
    }
}

// @desc    Generate MCQ questions using AI
// @route   POST /api/ai/generate-questions
// Helper function to call Groq AI iteratively handling all backend function calls
// Helper function to call OpenAI iteratively handling all backend function calls
async function callOpenAIWithTools(messages, tools, maxLoops = 3) {
    let loopCount = 0;
    const { executeAgentTool } = await import('../services/aiAgentTools.js');

    while (loopCount < maxLoops) {
        loopCount++;

        try {
            const res = await (await import('axios')).default.post(
                'https://api.openai.com/v1/chat/completions', // 🌟 OpenAI URL
                {
                    model: 'gpt-4o-mini', // 🌟 Paid OpenAI Model
                    messages: messages,
                    tools: tools,
                    tool_choice: 'auto',
                    max_tokens: 2000,
                    temperature: 0.5,
                },
                {
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, // 🌟 Ensure this key is in your .env file
                    },
                }
            );

            const responseMessage = res.data.choices[0].message;
            messages.push(responseMessage);

            // Agar AI ne koi tool call nahi kiya, toh sidha jawab return kar do
            if (!responseMessage.tool_calls || responseMessage.tool_calls.length === 0) {
                return responseMessage.content || '';
            }

            // Agar AI ne tool call kiya hai, toh usko execute karo
            const toolResults = await Promise.all(
                responseMessage.tool_calls
                    .filter(tc => tc.type === 'function')
                    .map(async (toolCall) => {
                        const functionResponse = await executeAgentTool(
                            toolCall.function.name,
                            toolCall.function.arguments
                        );
                        return {
                            tool_call_id: toolCall.id,
                            role: 'tool',
                            name: toolCall.function.name,
                            content: functionResponse,
                        };
                    })
            );

            // Tool ka result messages array mein daal kar loop continue karo
            messages.push(...toolResults);
        } catch (error) {
            console.error('OpenAI Agentic Loop Error:', error.response?.data || error.message);
            throw new Error(error.response?.data?.error?.message || 'AI Chat failed');
        }
    }
    return "Agentic loop limit reached. Please refine your question or ask in smaller parts.";
}

export const generateQuestions = async (req, res) => {
    try {
        if (!GROQ_API_KEY) {
            return res.status(500).json({
                success: false,
                message: 'Groq API key not configured',
            });
        }

        const { topic, count = 5, difficulty = 'medium', type = 'mcq' } = req.body;

        if (!topic || typeof topic !== 'string') {
            return res.status(400).json({
                success: false,
                message: 'Topic is required',
            });
        }

        // Validate count
        const questionCount = Math.min(Math.max(Number(count), 1), 20);

        const isSubjective = type === 'subjective';

        const prompt = isSubjective ? `
You are an expert exam question generator for educational purposes.

Task:
Generate ${questionCount} high-quality subjective/open-ended questions about: "${topic}".

Requirements for each question:
- "question": A clear, thought-provoking subjective question.
- "idealAnswer": A comprehensive ideal answer or grading rubric (3-4 sentences).
- "explanation": Brief explanation for the student (1-2 sentences).
- "difficulty": "${difficulty}" (Easy/Medium/Hard)

Return ONLY a valid JSON array with no additional text:
[
  {
    "question": "Explain the significance of the French Revolution.",
    "idealAnswer": "A good answer should mention the overthrow of the monarchy, the establishment of a republic, and the radical social and political changes. Key figures like Robespierre and events like the Reign of Terror should be noted, along with the long-term impact on democratic ideals in Europe.",
    "explanation": "The French Revolution was a watershed event in modern European history that began in 1789.",
    "difficulty": "Medium"
  }
]
` : `
You are an expert exam question generator for educational purposes.

Task:
Generate ${questionCount} high-quality multiple-choice questions about: "${topic}".

Requirements for each question:
- "question": A clear, specific question (avoid ambiguity)
- "options": Array of exactly 4 distinct options (A, B, C, D format)
- "correctAnswer": The correct option text (must exactly match one option)
- "explanation": Brief explanation of why the answer is correct (1-2 sentences)
- "difficulty": "${difficulty}" (Easy/Medium/Hard)

Guidelines:
- Questions should test understanding, not just memorization
- Options should be plausible but only one correct
- Avoid trick questions
- Keep language simple and professional

Return ONLY a valid JSON array with no additional text:
[
  {
    "question": "What is the capital of France?",
    "options": ["London", "Berlin", "Paris", "Madrid"],
    "correctAnswer": "Paris",
    "explanation": "Paris is the capital and largest city of France.",
    "difficulty": "Easy"
  }
]
`;

        // Call OpenAI
        const rawResponse = await callOpenAI(prompt);

        // Parse JSON safely
        let questions;
        try {
            let cleanedText = rawResponse.replace(/```(?:json)?/gi, '').trim();
            const jsonStart = cleanedText.indexOf('[');
            const jsonEnd = cleanedText.lastIndexOf(']') + 1;
            
            if (jsonStart === -1 || jsonEnd === 0) {
                throw new Error('No JSON array found in response');
            }

            let jsonText = cleanedText.slice(jsonStart, jsonEnd);
            // remove trailing commas just in case
            jsonText = jsonText.replace(/,\s*([\]}])/g, '$1');

            try {
                questions = JSON.parse(jsonText);
            } catch (parseError) {
                console.warn('Initial JSON parse failed, likely due to token truncation. Attempting to recover...', parseError.message);
                // Attempt to recover by stripping out the last incomplete object.
                const lastValidElementEnd = jsonText.lastIndexOf('},');
                if (lastValidElementEnd !== -1) {
                    jsonText = jsonText.substring(0, lastValidElementEnd + 1) + ']';
                    questions = JSON.parse(jsonText); // Try parsing the recovered JSON
                } else {
                    throw new Error('Failed to parse AI question response: ' + parseError.message);
                }
            }

            if (!Array.isArray(questions) || questions.length === 0) {
                throw new Error('Invalid questions array');
            }

            // Validate and format questions
            questions = questions.map((q, i) => {
                if (isSubjective) {
                    if (!q.question || !q.idealAnswer) {
                        throw new Error(`Invalid subjective question format at index ${i}`);
                    }
                    return {
                        question: String(q.question).trim(),
                        idealAnswer: String(q.idealAnswer).trim(),
                        explanation: String(q.explanation || '').trim(),
                        difficulty: String(q.difficulty || difficulty).trim(),
                        type: 'subjective'
                    };
                } else {
                    if (!q.question || !Array.isArray(q.options) || q.options.length !== 4) {
                        throw new Error(`Invalid MCQ question format at index ${i}`);
                    }
                    return {
                        question: String(q.question).trim(),
                        options: q.options.map(opt => String(opt).trim()),
                        correctAnswer: String(q.correctAnswer || q.options[0]).trim(),
                        explanation: String(q.explanation || '').trim(),
                        difficulty: String(q.difficulty || difficulty).trim(),
                        type: 'mcq'
                    };
                }
            });

        } catch (parseError) {
            console.error('JSON parse error:', parseError);
            return res.status(500).json({
                success: false,
                message: 'AI returned invalid format',
                details: rawResponse.substring(0, 500),
            });
        }

        res.status(200).json({
            success: true,
            count: questions.length,
            questions,
        });

        // Log usage
        logAIUsage(req.user.id, 'question_generation', { topic, count: questions.length, difficulty });

    } catch (error) {
        console.error('Generate questions error:', error.response?.data || error.message);
        const isRateLimit = error?.response?.status === 429 || error?.message?.includes('429');
        
        res.status(500).json({
            success: false,
            message: isRateLimit ? 'AI rate limit exceeded (Too many requests). Please try again after 1 minute.' : 'Failed to generate questions. AI might have returned invalid format.',
        });
    }
};

// @desc    Generate quiz for a specific lesson
// @route   POST /api/ai/generate-lesson-quiz
export const generateLessonQuiz = async (req, res) => {
    try {
        if (!GROQ_API_KEY) {
            return res.status(500).json({
                success: false,
                message: 'Groq API key not configured',
            });
        }

        const {
            lessonTitle,
            lessonDescription,
            count = 5,
            difficulty = 'medium',
            customInstructions,
        } = req.body;

        if (!lessonTitle) {
            return res.status(400).json({
                success: false,
                message: 'Lesson title is required',
            });
        }

        const questionCount = Math.min(Math.max(Number(count), 1), 15);

        const prompt = `
You are creating a quiz for an educational lesson.

Lesson Title: "${lessonTitle}"
Lesson Description: "${lessonDescription || 'Not provided'}"
Additional Instructions: "${customInstructions || 'None'}"

Generate ${questionCount} multiple-choice questions specifically about this lesson content.

Requirements:
- Questions should directly test understanding of the lesson material
- Difficulty level: ${difficulty}
- Each question needs: question, 4 options, correctAnswer, explanation
- Make questions practical and relevant to real-world application

Return ONLY valid JSON array:
[
  {
    "question": "...",
    "options": ["...", "...", "...", "..."],
    "correctAnswer": "...",
    "explanation": "...",
    "difficulty": "${difficulty}"
  }
]
`;

        const rawResponse = await callGroqAI(prompt);

        // Parse and validate
        let questions;
        try {
            const jsonStart = rawResponse.indexOf('[');
            const jsonEnd = rawResponse.lastIndexOf(']') + 1;
            const jsonText = rawResponse.slice(jsonStart, jsonEnd);
            questions = JSON.parse(jsonText);

            questions = questions.map(q => ({
                question: String(q.question).trim(),
                options: q.options.map(opt => String(opt).trim()),
                correctAnswer: String(q.correctAnswer).trim(),
                explanation: String(q.explanation || '').trim(),
                difficulty: String(q.difficulty || difficulty).trim(),
            }));

        } catch (parseError) {
            return res.status(500).json({
                success: false,
                message: 'AI returned invalid format',
            });
        }

        res.status(200).json({
            success: true,
            count: questions.length,
            questions,
        });

    } catch (error) {
        console.error('Generate lesson quiz error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to generate quiz',
            
        });
    }
};

// @desc    Chat with AI Tutor regarding a specific lesson
// @route   POST /api/ai/tutor-chat
export const chatWithTutor = async (req, res) => {
    try {
        if (!GROQ_API_KEY) {
            return res.status(500).json({ success: false, message: 'Groq API key not configured' });
        }

        const { lessonId, message, history = [] } = req.body;

        if (!lessonId || !message) {
            return res.status(400).json({ success: false, message: 'Lesson ID and message are required' });
        }

        // Fetch lesson context
        const lesson = await Lesson.findById(lessonId);
        if (!lesson) {
            return res.status(404).json({ success: false, message: 'Lesson not found' });
        }

        const lessonContext = `
        Lesson Title: ${lesson.title}
        Lesson Description: ${lesson.description || 'No description provided'}
        Content Text: ${lesson.content?.text || 'No additional text content'}
        `;

        // Build citation source info
        const citations = [{
            source: 'Lesson',
            title: lesson.title,
            description: lesson.description || '',
            id: lesson._id,
        }];

        // If lesson has attachments, include them as additional citation sources
        if (lesson.content?.attachments?.length > 0) {
            lesson.content.attachments.forEach(att => {
                citations.push({
                    source: 'Attachment',
                    title: att.name || att.originalName || 'Document',
                    id: att._id || null,
                });
            });
        }

        // Format history for Groq
        const formattedHistory = history.map(msg => ({
            role: msg.role === 'tutor' ? 'assistant' : 'user',
            content: msg.content
        }));

        const systemPrompt = {
            role: 'system',
            content: `You are Sapience AI, an expert tutor guiding a student through the lesson material. 
            Use the following lesson context to answer the student's questions. 
            If the question is completely unrelated to the lesson or educational topics, politely guide them back to the subject.
            Keep your answers concise, encouraging, and educational. Use Markdown formatting.
            
            IMPORTANT: When you reference information from the lesson, include the source at the end of your answer in this format:
            ---
            📚 **Source:** [Lesson title or document name]
            
            Lesson Context:
            ${lessonContext}`
        };

        const messages = [
            systemPrompt,
            ...formattedHistory,
            { role: 'user', content: message }
        ];

        const responseText = await callGroqAIChat(messages);

        res.status(200).json({
            success: true,
            reply: responseText,
            citations,
        });

        // Log usage
        logAIUsage(req.user.id, 'tutor_chat', { lessonId });

    } catch (error) {
        console.error('AI Tutor Chat error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to communicate with AI Tutor',
            
        });
    }
};

// @desc    RAG-based AI Tutor Chat with Citations
// @route   POST /api/ai/tutor-chat-rag
export const tutorChatRAG = async (req, res) => {
    try {
        if (!GROQ_API_KEY) {
            return res.status(500).json({
                success: false,
                message: 'Groq API key not configured'
            });
        }

        const { message, courseId, lessonId } = req.body;

        if (!message) {
            return res.status(400).json({
                success: false,
                message: 'Message is required'
            });
        }

        // Get user's instituteId
        const user = await (await import('../models/User.js')).default.findById(req.user.id);
        const instituteId = user?.instituteId;

        // Perform similarity search to get relevant context
        let context = '';
        let citations = [];

        try {
            const searchResults = await VectorService.similaritySearch(
                message,
                courseId,
                instituteId,
                5
            );

            if (searchResults && searchResults.length > 0) {
                context = searchResults.map((result, index) =>
                    `[Source ${index + 1}]: ${result.content}`
                ).join('\n\n');

                citations = searchResults.map((result, index) => ({
                    id: index + 1,
                    lessonTitle: result.lesson.title,
                    contentType: result.contentType,
                    content: result.content.substring(0, 200) + '...',
                    similarity: result.similarity,
                    metadata: result.metadata
                }));
            }
        } catch (searchError) {
            console.error('Vector search error:', searchError);
            // Continue without context if search fails
        }

        // Build messages array for Groq AI
        const messages = [
            {
                role: 'system',
                content: `You are an expert AI Tutor for Sapience LMS. You help students learn effectively by providing accurate, educational answers.

${context ? `Context from course materials:
${context}

IMPORTANT: Use the provided context to answer the student's question. If the context doesn't contain enough information, you can supplement with your general knowledge but clearly indicate when you're doing so.

CITATION FORMAT: When using information from the context, include citations like [Source 1], [Source 2] etc.` : 'Provide helpful educational answers based on your general knowledge.'}

Guidelines:
- Be educational and encouraging
- Explain concepts clearly
- Provide examples when helpful
- Include citations when using context materials
- If you don't know something, admit it honestly
- Keep responses concise but thorough`
            },
            {
                role: 'user',
                content: message
            }
        ];

        const responseText = await callGroqAIChat(messages);

        res.status(200).json({
            success: true,
            reply: responseText,
            citations,
            contextUsed: context.length > 0
        });

        // Log usage
        await logAIUsage(req.user.id, 'tutor_chat', {
            courseId,
            lessonId,
            citationsCount: citations.length
        });

    } catch (error) {
        console.error('RAG AI Tutor Chat error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to communicate with AI Tutor',
            
        });
    }
};

// @desc    Generate personalized analytics for a student
// @route   GET /api/ai/analytics/student
export const generateStudentAnalytics = async (req, res) => {
    try {
        if (!GROQ_API_KEY) {
            return res.status(500).json({ success: false, message: 'Groq API key not configured' });
        }

        const studentId = req.user._id;

        const enrollments = await Enrollment.find({ studentId }).populate('courseId', 'title category level');
        const quizAttempts = await QuizAttempt.find({ studentId }).sort('-createdAt').limit(10).populate('lessonId', 'title');

        let studentDataText = 'Enrollments:\n';
        enrollments.forEach(e => {
            studentDataText += `- Course: ${e.courseId?.title || 'Unknown'}, Progress: ${e.progress?.percentage || 0}%\n`;
        });

        studentDataText += '\nRecent Quiz Attempts:\n';
        quizAttempts.forEach(q => {
            studentDataText += `- Lesson: ${q.lessonId?.title || 'Unknown'}, Score: ${q.score}% (${q.isPassed ? 'Passed' : 'Failed'})\n`;
        });

        if (enrollments.length === 0 && quizAttempts.length === 0) {
            studentDataText = "The student has just joined and has no active enrollments or quiz attempts yet.";
        }

        const prompt = `
        You are an elite AI educational analyst for Sapience LMS.
        Analyze the following student data and generate a personalized learning report.

        Student Data:
        ${studentDataText}

        Task: Produce a structured JSON response containing:
        - "weakTopics": Array of strings (up to 3 areas the student should improve, based on low scores or extrapolate).
        - "strongTopics": Array of strings (up to 3 areas the student excels at).
        - "successProbability": A number from 0 to 100 estimating their likelihood of completing current courses with good grades.
        - "dropoutRisk": A string, strictly one of ["Low", "Medium", "High"].
        - "studyPlan": An array of exactly 3 objects, each with {"step": string, "description": string} containing actionable advice.

        Return ONLY a valid JSON object. Do not include markdown formatting or backticks around the JSON.
        `;

        const rawResponse = await callGroqAI(prompt);

        const jsonStart = rawResponse.indexOf('{');
        const jsonEnd = rawResponse.lastIndexOf('}') + 1;

        if (jsonStart === -1 || jsonEnd === 0) {
            throw new Error('No JSON object found in response');
        }

        const jsonText = rawResponse.slice(jsonStart, jsonEnd);
        const analytics = JSON.parse(jsonText);

        res.status(200).json({
            success: true,
            analytics
        });

        // Log usage
        logAIUsage(req.user.id, 'analytics', { enrollmentCount: enrollments.length });

    } catch (error) {
        console.error('Analytics generation error:', error);
        res.status(500).json({ success: false, message: 'Failed to generate analytics' });
    }
};

// @desc    Summarize a lesson using AI
// @route   POST /api/ai/summarize-lesson
// @access  Private
export const summarizeLesson = async (req, res) => {
    try {
        if (!GROQ_API_KEY) {
            return res.status(500).json({ success: false, message: 'Groq API key not configured' });
        }

        const { lessonId, courseId, lessonTitle, content } = req.body;

        let title, description, textContent;

        if (lessonId) {
            // Lesson-level summarize
            const lesson = await Lesson.findById(lessonId);
            if (!lesson) return res.status(404).json({ success: false, message: 'Lesson not found' });
            title = lesson.title;
            description = lesson.description || '';
            textContent = lesson.content?.text || '';
        } else if (courseId || lessonTitle) {
            // Course-level summarize (from student course page)
            title = lessonTitle || 'Course';
            description = content || '';
            textContent = content || '';
        } else {
            return res.status(400).json({ success: false, message: 'Lesson ID or course details are required' });
        }

        const prompt = `
You are an expert educational content summarizer.

Summarize the following in a clear, structured format:
- Use bullet points for key concepts
- Include the most important takeaways
- Keep it concise but comprehensive (max 300 words)
- Use Markdown formatting

Title: "${title}"
Description: "${description}"
Content: "${textContent || 'Video/multimedia content — summarize based on title and description'}"
`;

        const summary = await callGroqAI(prompt);

        logAIUsage(req.user.id, 'summarize_lesson', { lessonId: lessonId || courseId });

        res.status(200).json({
            success: true,
            summary,
            lessonTitle: title,
        });
    } catch (error) {
        console.error('Summarize lesson error:', error);
        res.status(500).json({ success: false, message: 'Failed to summarize lesson' });
    }
};

// @desc    Generate revision notes for a lesson using AI
// @route   POST /api/ai/revision-notes
// @access  Private
export const generateRevisionNotes = async (req, res) => {
    try {
        if (!GROQ_API_KEY) {
            return res.status(500).json({ success: false, message: 'Groq API key not configured' });
        }

        const { lessonId, courseId, lessonTitle, content } = req.body;

        let title, description, textContent;

        if (lessonId) {
            const lesson = await Lesson.findById(lessonId);
            if (!lesson) return res.status(404).json({ success: false, message: 'Lesson not found' });
            title = lesson.title;
            description = lesson.description || '';
            textContent = lesson.content?.text || '';
        } else if (courseId || lessonTitle) {
            title = lessonTitle || 'Course';
            description = content || '';
            textContent = content || '';
        } else {
            return res.status(400).json({ success: false, message: 'Lesson ID or course details are required' });
        }

        const prompt = `
You are an expert at creating revision notes for students.

Create comprehensive revision notes for the following:
- Include key definitions and concepts
- Add formulas or important facts if applicable
- Create memory aids / mnemonics where helpful
- Add 3-5 quick review questions at the end
- Use Markdown formatting with headers, bold, and bullet points

Title: "${title}"
Description: "${description}"
Content: "${textContent || 'Video/multimedia content — create notes based on title and description'}"
`;

        const notes = await callGroqAI(prompt);

        logAIUsage(req.user.id, 'revision_notes', { lessonId: lessonId || courseId });

        res.status(200).json({
            success: true,
            notes,
            lessonTitle: title,
        });
    } catch (error) {
        console.error('Revision notes error:', error);
        res.status(500).json({ success: false, message: 'Failed to generate revision notes' });
    }
};

// @desc    Explain a lesson concept using AI
// @route   POST /api/ai/explain-concept
// @access  Private
export const explainConcept = async (req, res) => {
    try {
        if (!GROQ_API_KEY) {
            return res.status(500).json({ success: false, message: 'Groq API key not configured' });
        }

        const { lessonId, courseId, lessonTitle, content } = req.body;

        let title, description, textContent;

        if (lessonId) {
            const lesson = await Lesson.findById(lessonId);
            if (!lesson) return res.status(404).json({ success: false, message: 'Lesson not found' });
            title = lesson.title;
            description = lesson.description || '';
            textContent = lesson.content?.text || '';
        } else if (courseId || lessonTitle) {
            title = lessonTitle || 'Course';
            description = content || '';
            textContent = content || '';
        } else {
            return res.status(400).json({ success: false, message: 'Lesson ID or course details are required' });
        }

        const prompt = `
You are an expert AI tutor. Explain the core concepts of the following topic in simple, easy-to-understand terms.

Guidelines:
- Break down complex terms into simple analogies
- Use real-world examples to illustrate the concept
- Format key terms in **bold**
- Structure the explanation with headings and bullet points using Markdown
- Keep the tone warm, engaging, and educational

Title: "${title}"
Description: "${description}"
Content: "${textContent || 'Video/multimedia content — explain concept based on title and description'}"
`;

        const explanation = await callGroqAI(prompt);

        logAIUsage(req.user.id, 'explain_concept', { lessonId: lessonId || courseId });

        res.status(200).json({
            success: true,
            explanation,
            lessonTitle: title,
        });
    } catch (error) {
        console.error('Explain concept error:', error);
        res.status(500).json({ success: false, message: 'Failed to explain concept' });
    }
};

// @desc    Generate practice questions for a lesson using AI
// @route   POST /api/ai/practice-questions
// @access  Private
export const generatePracticeQuestions = async (req, res) => {
    try {
        if (!GROQ_API_KEY) {
            return res.status(500).json({ success: false, message: 'Groq API key not configured' });
        }

        const { lessonId, courseId, lessonTitle, content } = req.body;

        let title, description, textContent;

        if (lessonId) {
            const lesson = await Lesson.findById(lessonId);
            if (!lesson) return res.status(404).json({ success: false, message: 'Lesson not found' });
            title = lesson.title;
            description = lesson.description || '';
            textContent = lesson.content?.text || '';
        } else if (courseId || lessonTitle) {
            title = lessonTitle || 'Course';
            description = content || '';
            textContent = content || '';
        } else {
            return res.status(400).json({ success: false, message: 'Lesson ID or course details are required' });
        }

        const prompt = `
You are an expert educator. Generate 3-5 high-quality practice questions to test a student's understanding of this topic.

Guidelines:
- Provide a mix of multiple-choice, fill-in-the-blank, or short-answer questions.
- Include a separate "Answer Key" section with clear explanations for each answer.
- Format using Markdown with clear headings and bullet points.
- Keep the tone encouraging and academic.

Title: "${title}"
Description: "${description}"
Content: "${textContent || 'Video/multimedia content — generate practice questions based on title and description'}"
`;

        const questions = await callGroqAI(prompt);

        logAIUsage(req.user.id, 'practice_questions', { lessonId: lessonId || courseId });

        res.status(200).json({
            success: true,
            questions,
            lessonTitle: title,
        });
    } catch (error) {
        console.error('Practice questions error:', error);
        res.status(500).json({ success: false, message: 'Failed to generate practice questions' });
    }
};

// @desc    Contextual Chat with AI Assistant (adapts to current page context)
// @route   POST /api/ai/contextual-chat
export const contextualChat = async (req, res) => {
    try {
        if (!GROQ_API_KEY) {
            return res.status(500).json({ success: false, message: 'Groq API key not configured' });
        }

        const { message, history = [], context = {} } = req.body;

        if (!message) {
            return res.status(400).json({ success: false, message: 'Message is required' });
        }

        let systemContext = `You are a helpful, expert AI assistant embedded directly within a student's learning platform. Your goal is to provide concise, accurate, and highly relevant guidance.
        Keep formatting clean using Markdown (bullet points, bolding).
        `;

        // Enhance system prompt dynamically based on the provided context
        if (context.pageType === 'assignment_upload') {
            systemContext += `\n\nCURRENT CONTEXT: The student is currently on the "Upload Assignment" page, preparing to submit their work.`;
            if (context.courseId) {
                const course = await (await import('../models/Course.js')).default.findById(context.courseId).select('title');
                if (course) systemContext += `\nThey have selected the course: "${course.title}".`;
            }
            if (context.assignmentId) {
                const assignment = await (await import('../models/Assignment.js')).default.findById(context.assignmentId);
                if (assignment) {
                    systemContext += `\nThey are uploading a submission for the assignment titled: "${assignment.title}".`;
                    if (assignment.description) systemContext += `\nAssignment Details: ${assignment.description}`;
                    if (assignment.totalMarks) systemContext += `\nTotal Marks: ${assignment.totalMarks}`;
                    systemContext += `\nProvide guidance strictly relevant to helping them complete, format, or understand this specific assignment. Do not write the assignment for them; rather, act as an academic tutor giving them hints, clarifying the requirements, or helping structure their response.`;
                }
            } else {
                systemContext += `\nThey have not yet selected a specific assignment.`;
            }
        } else if (context.pageType === 'course_details') {
            systemContext += `\n\nCURRENT CONTEXT: The student is viewing a Course overview/curriculum page.`;
            if (context.courseId) {
                const course = await (await import('../models/Course.js')).default.findById(context.courseId).populate({
                    path: 'tutorId',
                    populate: { path: 'userId', select: 'name bio' }
                });
                const Enrollment = (await import('../models/Enrollment.js')).default;
                const Lesson = (await import('../models/Lesson.js')).default;

                if (course) {
                    const totalLessons = await Lesson.countDocuments({ courseId: course._id });
                    const enrollment = await Enrollment.findOne({ studentId: req.user._id, courseId: course._id });
                    const Assignment = (await import('../models/Assignment.js')).default;
                    const Submission = (await import('../models/Submission.js')).default;

                    const assignments = await Assignment.find({ courseId: course._id, status: 'published' }).select('title totalMarks _id');
                    let assignmentsMetadata = '';
                    if (assignments.length > 0) {
                        const assignmentIds = assignments.map(a => a._id);
                        const submissions = await Submission.find({ studentId: req.user._id, assignmentId: { $in: assignmentIds } });
                        const submissionMap = submissions.reduce((map, sub) => {
                            map[sub.assignmentId.toString()] = sub;
                            return map;
                        }, {});

                        assignmentsMetadata = `\n==== ASSIGNMENTS & MARKS ====`;
                        assignments.forEach((a, idx) => {
                            const sub = submissionMap[a._id.toString()];
                            let statusText = sub ? `[Submitted, Status: ${sub.status}]` : '[Not Submitted]';
                            if (sub && sub.status === 'graded') {
                                statusText += ` - Score: ${sub.grade}/${a.totalMarks}`;
                            } else {
                                statusText += ` - Max Marks: ${a.totalMarks}`;
                            }
                            assignmentsMetadata += `\n${idx + 1}. Title: "${a.title}" ${statusText}`;
                        });
                        assignmentsMetadata += `\n=============================`;
                    }

                    // Resources & Discussions Metadata
                    const LessonComment = (await import('../models/LessonComment.js')).default;
                    const courseLessons = await Lesson.find({ courseId: course._id });

                    let totalVideoDuration = 0;
                    let totalDocuments = 0;
                    let totalQuizzes = 0;

                    courseLessons.forEach(l => {
                        if (l.type === 'video' && l.content?.duration) totalVideoDuration += l.content.duration;
                        if (l.type === 'document') totalDocuments += 1;
                        if (l.type === 'quiz') totalQuizzes += 1;
                        if (l.content?.documents?.length) totalDocuments += l.content.documents.length;
                        if (l.content?.attachments?.length) totalDocuments += l.content.attachments.length;
                    });

                    const lessonIds = courseLessons.map(l => l._id);
                    const totalDiscussions = await LessonComment.countDocuments({ lessonId: { $in: lessonIds } });

                    let resourcesMetadata = `\n==== COURSE RESOURCES ====`;
                    resourcesMetadata += `\nTotal Video Duration: ${Math.floor(totalVideoDuration / 60)} minutes`;
                    resourcesMetadata += `\nTotal Downloadable Documents/Attachments: ${totalDocuments}`;
                    resourcesMetadata += `\nTotal Quizzes: ${totalQuizzes}`;
                    resourcesMetadata += `\nTotal Discussion Comments: ${totalDiscussions}`;
                    resourcesMetadata += `\n==========================`;

                    const tutorName = course.tutorId?.userId?.name || 'Unknown Tutor';
                    const tutorBio = course.tutorId?.bio || course.tutorId?.userId?.bio || 'No bio available';
                    const tutorExperience = course.tutorId?.experience ? `${course.tutorId.experience} years` : 'Unknown';
                    const tutorSubjects = course.tutorId?.subjects?.join(', ') || 'Various Subjects';

                    systemContext += `\nCourse Title: "${course.title}"`;
                    if (course.description) systemContext += `\nDescription: ${course.description}`;
                    if (course.whatYouWillLearn?.length) systemContext += `\nWhat they will learn: ${course.whatYouWillLearn.join(', ')}`;

                    systemContext += `\n\n==== COURSE METADATA (DO NOT HALLUCINATE) ====`;
                    systemContext += `\nTotal Lessons in Course: ${totalLessons}`;
                    systemContext += `\nTutor's Name: ${tutorName}`;
                    systemContext += `\nTutor's Experience: ${tutorExperience}`;
                    systemContext += `\nTutor's Subjects: ${tutorSubjects}`;
                    systemContext += `\nTutor's Bio: ${tutorBio}`;

                    if (enrollment) {
                        const progressPercent = enrollment.progress?.percentage || 0;
                        const completedCount = enrollment.progress?.completedLessons?.length || 0;
                        systemContext += `\nStudent's Current Progress: ${progressPercent}% completed (${completedCount} out of ${totalLessons} lessons finished).`;
                    } else {
                        systemContext += `\nStudent Status: NOT ENROLLED IN THIS COURSE yet. Provide guidance on why they should enroll based on the curriculum.`;
                    }
                    systemContext += `\n============================================\n`;
                    systemContext += assignmentsMetadata;
                    systemContext += resourcesMetadata;
                    systemContext += `\n`;

                    systemContext += `\nAct as a knowledgeable guide about this specific course. Answer questions about what topics it covers, curriculum counts, tutor profile, the prerequisites, and course objectives using the EXACT factual data provided above.`;
                }
            }
        } else if (context.pageType === 'tutor_profile') {
            systemContext += `\n\nCURRENT CONTEXT: The student is viewing a Tutor's public profile and booking page.`;
            if (context.tutorId) {
                const tutor = await (await import('../models/Tutor.js')).default.findById(context.tutorId).populate('userId', 'name');
                if (tutor) {
                    systemContext += `\nTutor Name: "${tutor.userId?.name || 'Tutor'}"`;
                    if (tutor.bio) systemContext += `\nBio: ${tutor.bio}`;
                    if (tutor.experience) systemContext += `\nExperience: ${tutor.experience} years`;
                    if (tutor.subjects?.length) systemContext += `\nSpecialties: ${tutor.subjects.join(', ')}`;
                    if (tutor.hourlyRate) systemContext += `\nHourly Rate: ₹${tutor.hourlyRate}`;
                    systemContext += `\nHelp the student determine if this tutor is a good fit for their learning needs based on the fields above. Highlight the tutor's relevant experience and specialties.`;
                }
            }
        } else {
            systemContext += `\n\nCURRENT CONTEXT: The student is navigating the educational platform roughly. Be an encouraging academic counselor.`;
        }

        const formattedHistory = history.map(msg => ({
            role: msg.role === 'ai' || msg.role === 'assistant' || msg.role === 'tutor' ? 'assistant' : 'user',
            content: msg.content
        }));

        const messages = [
            { role: 'system', content: systemContext },
            ...formattedHistory,
            { role: 'user', content: message }
        ];

        const responseText = await callGroqAIChat(messages);

        res.status(200).json({
            success: true,
            reply: responseText
        });

        logAIUsage(req.user.id, 'contextual_chat', { pageType: context.pageType });

    } catch (error) {
        console.error('Contextual Chat error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to communicate with AI',
            
        });
    }
};

// @desc    Get AI usage stats (for admin / billing)
// @route   GET /api/ai/usage-stats
// @access  Private/Admin
export const getAIUsageStats = async (req, res) => {
    try {
        const match = {};
        if (req.query.instituteId) match.instituteId = req.query.instituteId;
        if (req.query.userId) match.userId = req.query.userId;

        const stats = await AIUsageLog.aggregate([
            { $match: match },
            {
                $group: {
                    _id: '$action',
                    count: { $sum: 1 },
                },
            },
        ]);

        const totalUsage = stats.reduce((sum, s) => sum + s.count, 0);

        res.status(200).json({
            success: true,
            totalUsage,
            breakdown: stats,
        });
    } catch (error) {
        console.error('AI usage stats error:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch AI usage stats' });
    }
};

// ==========================================
// CHAT SESSION CONTROLLERS (New UI Revamp)
// ==========================================

// Helper to auto-generate a title for a new chat
async function generateChatTitle(firstMessage) {
    try {
        const prompt = `Generate a very short, concise title (max 5 words) summarizing this message/topic: "${firstMessage}". Return ONLY the title text.`;
        const title = await callGroqAI(prompt);
        return title.replace(/['"]/g, '').trim() || 'New Chat';
    } catch (e) {
        return 'New Chat';
    }
}

// @desc    Get all chat sessions for the mapped user
// @route   GET /api/ai/chat-sessions
export const getChatSessions = async (req, res) => {
    try {
        const sessions = await AIChatSession.find({ userId: req.user._id })
            .select('-messages') // Don't send entire history for list view
            .sort('-updatedAt')
            .populate('courseId', 'title');

        res.status(200).json({ success: true, count: sessions.length, sessions, data: sessions });
    } catch (error) {
        console.error('Get chat sessions error:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch chat sessions' });
    }
};

// @desc    Create a new chat session
// @route   POST /api/ai/chat-sessions
export const createChatSession = async (req, res) => {
    try {
        const { courseId, persona } = req.body;
        const isTutor = req.user?.role === 'tutor';
        const resolvedPersona = persona === 'tutor' || isTutor ? 'tutor' : 'student';

        const session = await AIChatSession.create({
            userId: req.user._id,
            courseId: courseId || null,
            persona: resolvedPersona,
            messages: []
        });

        res.status(201).json({ success: true, session, data: session });
    } catch (error) {
        console.error('Create chat session error:', error);
        res.status(500).json({ success: false, message: 'Failed to create chat session' });
    }
};

// @desc    Get a specific chat session by ID
// @route   GET /api/ai/chat-sessions/:id
export const getChatSessionById = async (req, res) => {
    try {
        const session = await AIChatSession.findOne({ _id: req.params.id, userId: req.user._id })
            .populate('courseId', 'title');

        if (!session) {
            return res.status(404).json({ success: false, message: 'Chat session not found' });
        }

        res.status(200).json({ success: true, session, data: session });
    } catch (error) {
        console.error('Get chat session error:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch chat session' });
    }
};

// @desc    Delete a chat session
// @route   DELETE /api/ai/chat-sessions/:id
export const deleteChatSession = async (req, res) => {
    try {
        const session = await AIChatSession.findOneAndDelete({ _id: req.params.id, userId: req.user._id });

        if (!session) {
            return res.status(404).json({ success: false, message: 'Chat session not found' });
        }

        res.status(200).json({ success: true, message: 'Chat session deleted' });
    } catch (error) {
        console.error('Delete chat session error:', error);
        res.status(500).json({ success: false, message: 'Failed to delete chat session' });
    }
};

// @desc    Add a message to a session and get AI response
// @route   POST /api/ai/chat-sessions/:id/message
export const addMessageToChatSession = async (req, res) => {
    try {
        if (!GROQ_API_KEY) {
            return res.status(500).json({ success: false, message: 'Groq API key not configured' });
        }

        const { message } = req.body;
        if (!message) {
            return res.status(400).json({ success: false, message: 'Message text is required' });
        }

        const session = await AIChatSession.findOne({ _id: req.params.id, userId: req.user._id });
        if (!session) {
            return res.status(404).json({ success: false, message: 'Chat session not found' });
        }

        // Auto-generate title if this is the first message
        if (session.messages.length === 0) {
            const title = await generateChatTitle(message);
            session.title = title;
        }

        // Save User Message
        const userMsg = { role: 'user', content: message, timestamp: new Date() };
        session.messages.push(userMsg);

        const sessionPersona = session.persona || (req.user?.role === 'tutor' ? 'tutor' : 'student');
        const isTutorPersona = sessionPersona === 'tutor';

        // Perform RAG if courseId is available
        let context = '';
        let citations = [];
        let contextUsed = false;
        let liveCourseMetadata = '';
        let courseContextAllowed = true;

        if (session.courseId) {
            try {
                if (isTutorPersona) {
                    const Tutor = (await import('../models/Tutor.js')).default;
                    const Course = (await import('../models/Course.js')).default;
                    const tutor = await Tutor.findOne({ userId: req.user._id }).select('_id').lean();
                    const allowedCourse = tutor
                        ? await Course.findOne({ _id: session.courseId, tutorId: tutor._id }).select('_id').lean()
                        : null;
                    if (!allowedCourse) {
                        courseContextAllowed = false;
                    }
                }

                if (!courseContextAllowed) {
                    context = '';
                    citations = [];
                } else {
                    // Get user's instituteId for Vector Search
                    const user = await (await import('../models/User.js')).default.findById(req.user._id);
                    const instituteId = user?.instituteId;

                    const searchResults = await VectorService.similaritySearch(
                        message,
                        session.courseId,
                        instituteId,
                        4
                    );

                    if (searchResults && searchResults.length > 0) {
                        context = searchResults.map((result, index) =>
                            `[Source ${index + 1}]: ${result.content}`
                        ).join('\n\n');

                        citations = searchResults.map((result, index) => ({
                            id: index + 1,
                            title: result.lesson.title,
                            content: result.content.substring(0, 200) + '...',
                            similarity: result.similarity
                        }));
                        contextUsed = true;
                    }
                }

                // Fetch dynamic course / tutor / enrollment metadata for AI context
                if (courseContextAllowed) {
                    try {
                        const Course = (await import('../models/Course.js')).default;
                        const Lesson = (await import('../models/Lesson.js')).default;
                        const Enrollment = (await import('../models/Enrollment.js')).default;
                        const Tutor = (await import('../models/Tutor.js')).default;

                        const courseDetails = await Course.findById(session.courseId).populate({
                            path: 'tutorId',
                            populate: { path: 'userId', select: 'name bio' }
                        });

                        let enrollment = null;
                        if (!isTutorPersona) {
                            enrollment = await Enrollment.findOne({ studentId: req.user._id, courseId: session.courseId });
                        }

                        if (courseDetails) {
                            const Assignment = (await import('../models/Assignment.js')).default;
                            const Submission = (await import('../models/Submission.js')).default;

                            const assignments = await Assignment.find({ courseId: session.courseId, status: 'published' }).select('title totalMarks _id');
                            let assignmentsMetadata = '';
                            if (assignments.length > 0) {
                                const assignmentIds = assignments.map(a => a._id);
                                assignmentsMetadata = `\n== ASSIGNMENTS & MARKS ==`;
                                if (isTutorPersona) {
                                    const submissionStats = await Submission.aggregate([
                                        { $match: { assignmentId: { $in: assignmentIds } } },
                                        {
                                            $group: {
                                                _id: '$assignmentId',
                                                total: { $sum: 1 },
                                                graded: { $sum: { $cond: [{ $eq: ['$status', 'graded'] }, 1, 0] } },
                                                pendingReview: { $sum: { $cond: [{ $eq: ['$status', 'submitted'] }, 1, 0] } },
                                            },
                                        },
                                    ]);
                                    const statsMap = submissionStats.reduce((map, row) => {
                                        map[row._id.toString()] = row;
                                        return map;
                                    }, {});

                                    assignments.forEach((a, idx) => {
                                        const stat = statsMap[a._id.toString()] || { total: 0, graded: 0, pendingReview: 0 };
                                        assignmentsMetadata += `\n${idx + 1}. Title: "${a.title}" [Total Submissions: ${stat.total}, Graded: ${stat.graded}, Pending Review: ${stat.pendingReview}] - Max Marks: ${a.totalMarks}`;
                                    });
                                } else {
                                    const submissions = await Submission.find({ studentId: req.user._id, assignmentId: { $in: assignmentIds } });
                                    const submissionMap = submissions.reduce((map, sub) => {
                                        map[sub.assignmentId.toString()] = sub;
                                        return map;
                                    }, {});

                                    assignments.forEach((a, idx) => {
                                        const sub = submissionMap[a._id.toString()];
                                        let statusText = sub ? `[Submitted, Status: ${sub.status}]` : '[Not Submitted]';
                                        if (sub && sub.status === 'graded') {
                                            statusText += ` - Score: ${sub.grade}/${a.totalMarks}`;
                                        } else {
                                            statusText += ` - Max Marks: ${a.totalMarks}`;
                                        }
                                        assignmentsMetadata += `\n${idx + 1}. Title: "${a.title}" ${statusText}`;
                                    });
                                }
                            }

                            // Resources & Discussions Metadata
                            const LessonComment = (await import('../models/LessonComment.js')).default;
                            const courseLessons = await Lesson.find({ courseId: session.courseId });

                            let totalVideoDuration = 0;
                            let totalDocuments = 0;
                            let totalQuizzes = 0;

                            courseLessons.forEach(l => {
                                if (l.type === 'video' && l.content?.duration) totalVideoDuration += l.content.duration;
                                if (l.type === 'document') totalDocuments += 1;
                                if (l.type === 'quiz') totalQuizzes += 1;
                                if (l.content?.documents?.length) totalDocuments += l.content.documents.length;
                                if (l.content?.attachments?.length) totalDocuments += l.content.attachments.length;
                            });

                            const lessonIds = courseLessons.map(l => l._id);
                            const totalDiscussions = await LessonComment.countDocuments({ lessonId: { $in: lessonIds } });

                            let resourcesMetadata = `\n== COURSE RESOURCES ==`;
                            resourcesMetadata += `\nTotal Video Duration: ${Math.floor(totalVideoDuration / 60)} minutes`;
                            resourcesMetadata += `\nTotal Downloadable Documents/Attachments: ${totalDocuments}`;
                            resourcesMetadata += `\nTotal Quizzes: ${totalQuizzes}`;
                            resourcesMetadata += `\nTotal Discussion Comments: ${totalDiscussions}`;

                            const totalLessons = courseLessons.length;
                            const tutorName = courseDetails.tutorId?.userId?.name || 'Unknown Tutor';
                            const tutorBio = courseDetails.tutorId?.bio || courseDetails.tutorId?.userId?.bio || 'No bio available';
                            const tutorExperience = courseDetails.tutorId?.experience ? `${courseDetails.tutorId.experience} years` : 'Unknown';
                            const tutorSubjects = courseDetails.tutorId?.subjects?.join(', ') || 'Various Subjects';
                            if (isTutorPersona) {
                                const tutorProfile = await Tutor.findOne({ userId: req.user._id }).select('_id').lean();
                                const totalEnrollments = await Enrollment.countDocuments({ courseId: session.courseId });
                                const pendingReviews = await Submission.countDocuments({
                                    assignmentId: { $in: assignments.map((a) => a._id) },
                                    status: 'submitted',
                                });
                                const isOwner = tutorProfile && courseDetails.tutorId?._id?.toString() === tutorProfile._id.toString();

                                liveCourseMetadata = `
== COURSE METADATA (DO NOT HALLUCINATE) ==
Course Title: ${courseDetails.title}
Course Description: ${courseDetails.description}
Total Lessons in Course: ${totalLessons}
Tutor's Name: ${tutorName}
Tutor's Experience: ${tutorExperience}
Tutor's Subjects: ${tutorSubjects}
Tutor's Bio: ${tutorBio}
Total Enrolled Students: ${totalEnrollments}
Pending Assignment Reviews: ${pendingReviews}
You are currently ${isOwner ? 'the owner tutor' : 'a tutor user'} for this selected course context.
${assignmentsMetadata}
${resourcesMetadata}
============================================`;
                            } else {
                                const progressPercent = enrollment?.progress?.percentage || 0;
                                const completedCount = enrollment?.progress?.completedLessons?.length || 0;
                                liveCourseMetadata = `
== COURSE METADATA (DO NOT HALLUCINATE) ==
Course Title: ${courseDetails.title}
Course Description: ${courseDetails.description}
Total Lessons in Course: ${totalLessons}
Tutor's Name: ${tutorName}
Tutor's Experience: ${tutorExperience}
Tutor's Subjects: ${tutorSubjects}
Tutor's Bio: ${tutorBio}
Student's Current Progress: ${progressPercent}% completed (${completedCount} out of ${totalLessons} lessons finished).
${assignmentsMetadata}
${resourcesMetadata}
============================================`;
                            }
                        }
                    } catch (metaError) {
                        console.error('Metadata fetch error in chat session:', metaError);
                    }
                }

            } catch (searchError) {
                console.error('Vector search error in chat session:', searchError);
            }
        }

        // Build History Profile
        const systemPrompt = {
            role: 'system',
            content: isTutorPersona
                ? `You are Sapience AI Buddy, an expert assistant for educators.
Help the tutor with lesson planning, course structuring, quiz and assignment design, student engagement, feedback quality, and academic communication.
Be practical, concise, and pedagogically sound.
            
${liveCourseMetadata ? `Here are concrete facts about the selected course context:\n${liveCourseMetadata}\nIf the tutor asks about syllabus, assignments, class readiness, or course communication, use this exact data first.\n` : ''}

${contextUsed ? `CONTEXT FROM COURSE MATERIALS:
${context}

IMPORTANT: Use the above context to accurately answer the question. If the context doesn't have the answer, use your general knowledge but indicate it.
When referencing context, cite it using [Source 1], [Source 2].` : 'Provide helpful, encouraging, and accurate educational answers.'}

Format replies cleanly using Markdown.
Avoid claiming actions were executed unless explicitly asked and completed by system APIs.`
                : `You are Sapience AI, an elite educational tutor. Help the student learn effectively.
            
${liveCourseMetadata ? `Here are concrete facts about the course and the student's enrollment:\n${liveCourseMetadata}\nIf the student asks about the tutor, syllabus, or their progress, use this exact data exclusively.\n` : ''}

${contextUsed ? `CONTEXT FROM COURSE MATERIALS:
${context}

IMPORTANT: Use the above context to accurately answer the question. If the context doesn't have the answer, use your general knowledge but indicate it.
When referencing context, cite it using [Source 1], [Source 2].` : 'Provide helpful, encouraging, and accurate educational answers.'}

Format replies cleanly using Markdown.`
        };

        // Get last 15 messages for context window
        const recentHistory = session.messages.slice(-15).map(m => ({
            role: m.role,
            content: m.content
        }));

        const aiPayload = [systemPrompt, ...recentHistory];

        // Call Groq AI
        const responseText = await callGroqAIChat(aiPayload);

        // Save Assistant Message
        const aiMsg = {
            role: 'assistant',
            content: responseText,
            citations: citations,
            contextUsed: contextUsed,
            timestamp: new Date()
        };
        session.messages.push(aiMsg);

        await session.save();

        res.status(200).json({
            success: true,
            reply: aiMsg,
            sessionTitle: session.title, // Send back in case it was auto-updated
            data: session
        });

        // Log usage
        await logAIUsage(req.user._id, 'tutor_chat_session', {
            sessionId: session._id,
            courseId: session.courseId,
            persona: sessionPersona,
        });

    } catch (error) {
        console.error('Chat Session Message error:', error);
        res.status(500).json({ success: false, message: 'AI failed to respond' });
    }

};

export const getTutorAIDashboardStats = async (req, res) => {
    try {
        const tutorUserId = req.user._id;

        // ── 1. Total chat sessions ────────────────────────────────────
        const totalSessions = await AIChatSession.countDocuments({ userId: tutorUserId });

        // ── 2. Action-wise counts from AIUsageLog ─────────────────────
        const usageLogs = await AIUsageLog.find({ userId: tutorUserId });

        const actionCounts = usageLogs.reduce((acc, log) => {
            acc[log.action] = (acc[log.action] || 0) + 1;
            return acc;
        }, {});

        // Map to named stats
        const quizzesCreated = (actionCounts['question_generation'] || 0) + (actionCounts['generate_lesson_quiz'] || 0);
        const doubtsSolved = actionCounts['tutor_chat'] || 0 + actionCounts['tutor_chat_session'] || 0;
        const summariesGenerated = (actionCounts['summarize_lesson'] || 0) + (actionCounts['revision_notes'] || 0);
        const totalTasks = usageLogs.length;

        // ── 3. Last 7 days activity (for chart) ───────────────────────
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6); // 6 days back + today = 7 days
        sevenDaysAgo.setHours(0, 0, 0, 0);

        const recentLogs = await AIUsageLog.find({
            userId: tutorUserId,
            createdAt: { $gte: sevenDaysAgo },
        });

        const recentSessions = await AIChatSession.find({
            userId: tutorUserId,
            createdAt: { $gte: sevenDaysAgo },
        });

        // Build day-by-day data
        const dayLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
        const today = new Date();

        // Build last 7 days array [oldest → today]
        const last7Days = Array.from({ length: 7 }, (_, i) => {
            const d = new Date();
            d.setDate(today.getDate() - (6 - i));
            return d;
        });

        const chartData = last7Days.map((day) => {
            const dayStart = new Date(day); dayStart.setHours(0, 0, 0, 0);
            const dayEnd = new Date(day); dayEnd.setHours(23, 59, 59, 999);

            const chatsOnDay = recentSessions.filter(s => {
                const d = new Date(s.createdAt);
                return d >= dayStart && d <= dayEnd;
            }).length;

            const quizOnDay = recentLogs.filter(l => {
                const d = new Date(l.createdAt);
                return d >= dayStart && d <= dayEnd &&
                    (l.action === 'question_generation' || l.action === 'generate_lesson_quiz');
            }).length;

            return {
                day: dayLabels[day.getDay() === 0 ? 6 : day.getDay() - 1], // Mon=0
                aiChats: chatsOnDay,
                quizGenerated: quizOnDay,
            };
        });

        // ── 4. Recent activities feed ─────────────────────────────────
        const recentActivities = await AIUsageLog.find({ userId: tutorUserId })
            .sort({ createdAt: -1 })
            .limit(5)
            .lean();

        const actionLabels = {
            'question_generation': { title: 'Quiz Generated', sub: (d) => d?.topic || 'General' },
            'generate_lesson_quiz': { title: 'Lesson Quiz Created', sub: (d) => d?.lessonTitle || 'Lesson' },
            'tutor_chat': { title: 'Doubt Solved', sub: () => 'AI Chat' },
            'tutor_chat_session': { title: 'AI Chat Session', sub: () => 'AI Buddy' },
            'summarize_lesson': { title: 'Notes Simplified', sub: (d) => d?.lessonId ? 'Lesson' : 'Content' },
            'revision_notes': { title: 'Revision Notes', sub: () => 'Study Material' },
            'analytics': { title: 'Analytics Generated', sub: () => 'Student Report' },
            'contextual_chat': { title: 'Contextual Chat', sub: (d) => d?.pageType || 'Page' },
        };

        const formattedActivities = recentActivities.map(log => {
            const cfg = actionLabels[log.action] || { title: log.action, sub: () => '' };
            const diffMs = Date.now() - new Date(log.createdAt).getTime();
            const diffMin = Math.floor(diffMs / 60000);
            const timeAgo = diffMin < 1 ? 'Just now'
                : diffMin < 60 ? `${diffMin} min ago`
                    : diffMin < 1440 ? `${Math.floor(diffMin / 60)} hrs ago`
                        : `${Math.floor(diffMin / 1440)} days ago`;

            return {
                action: log.action,
                title: cfg.title,
                sub: cfg.sub(log.details || {}),
                timeAgo,
                createdAt: log.createdAt,
            };
        });

        // ── 5. Avg response time (from recent sessions) ───────────────
        const sessionsWithMessages = await AIChatSession.find({
            userId: tutorUserId,
            'messages.1': { $exists: true }, // at least 2 messages
        })
            .select('messages')
            .sort({ updatedAt: -1 })
            .limit(20)
            .lean();

        let totalResponseMs = 0;
        let responseCount = 0;

        sessionsWithMessages.forEach(session => {
            const msgs = session.messages || [];
            for (let i = 1; i < msgs.length; i++) {
                if (msgs[i].role === 'assistant' && msgs[i - 1].role === 'user') {
                    const diff = new Date(msgs[i].timestamp) - new Date(msgs[i - 1].timestamp);
                    if (diff > 0 && diff < 120000) { // sanity: < 2 min
                        totalResponseMs += diff;
                        responseCount++;
                    }
                }
            }
        });

        const avgResponseSec = responseCount > 0
            ? (totalResponseMs / responseCount / 1000).toFixed(1)
            : null;

        // ── 6. Active tools count (unique actions used) ───────────────
        const activeToolsCount = Object.keys(actionCounts).length;

        // ── 7. Tutor course count ─────────────────────────────────────
        let courseCount = 0;
        try {
            const Tutor = (await import('../models/Tutor.js')).default;
            const Course = (await import('../models/Course.js')).default;
            const tutorDoc = await Tutor.findOne({ userId: tutorUserId }).select('_id').lean();
            if (tutorDoc) {
                courseCount = await Course.countDocuments({ tutorId: tutorDoc._id });
            }
        } catch { /* ignore */ }

        // ── 8. Total students across tutor courses ────────────────────
        let totalStudents = 0;
        try {
            const Tutor = (await import('../models/Tutor.js')).default;
            const Course = (await import('../models/Course.js')).default;
            const Enrollment = (await import('../models/Enrollment.js')).default;
            const tutorDoc = await Tutor.findOne({ userId: tutorUserId }).select('_id').lean();
            if (tutorDoc) {
                const courses = await Course.find({ tutorId: tutorDoc._id }).select('_id').lean();
                const courseIds = courses.map(c => c._id);
                totalStudents = await Enrollment.countDocuments({ courseId: { $in: courseIds }, status: 'active' });
            }
        } catch { /* ignore */ }

        // ── Response ──────────────────────────────────────────────────
        res.status(200).json({
            success: true,
            stats: {
                // Overview cards
                totalStudents,
                courseCount,
                activeToolsCount,

                // AI specific
                totalSessions,
                totalTasks,
                quizzesCreated,
                doubtsSolved,
                summariesGenerated,

                // Usage stats (right panel in chat)
                avgResponseTime: avgResponseSec ? `${avgResponseSec}s` : 'N/A',
            },
            chartData,           // last 7 days
            recentActivities: formattedActivities,
        });

    } catch (error) {
        console.error('Tutor AI Dashboard Stats error:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch AI dashboard stats' });
    }
};

// @desc    Solve a doubt using Groq AI + save to DoubtLog
// @route   POST /api/ai/solve-doubt
// @access  Private
export const solveDoubt = async (req, res) => {
    try {
        if (!GROQ_API_KEY) {
            return res.status(500).json({ success: false, message: 'Groq API key not configured' });
        }

        const { question, subject, difficulty, courseId } = req.body;

        if (!question || !question.trim()) {
            return res.status(400).json({ success: false, message: 'Question is required' });
        }

        // ── Fetch course context (optional) ───────────────────────────
        let courseContext = '';
        if (courseId) {
            try {
                const Course = (await import('../models/Course.js')).default;
                const course = await Course.findById(courseId)
                    .select('title description whatYouWillLearn')
                    .lean();
                if (course) {
                    courseContext = `
Related Course: "${course.title}"
${course.description ? `Description: ${course.description}` : ''}
${course.whatYouWillLearn?.length ? `Topics: ${course.whatYouWillLearn.join(', ')}` : ''}
`;
                }
            } catch { /* course context is optional — proceed without it */ }
        }

        // ── Fetch user info for institute logging ─────────────────────
        let instituteId = null;
        try {
            const User = (await import('../models/User.js')).default;
            const user = await User.findById(req.user._id).select('instituteId role').lean();
            instituteId = user?.instituteId || null;
        } catch { /* non-critical */ }

        // ── Build AI prompt ───────────────────────────────────────────
        const prompt = `
You are an expert academic tutor. A user has asked the following doubt.
 
${subject ? `Subject: ${subject}` : ''}
${difficulty ? `Difficulty Level: ${difficulty}` : ''}
${courseContext}
 
Question / Doubt:
"${question.trim()}"
 
Instructions:
- Give a clear, detailed, step-by-step explanation.
- Use "## " prefix for section headings (e.g., ## Key Concept, ## Explanation, ## Example, ## Summary).
- Use "- " prefix for bullet point lists.
- Use "**term**" to bold important terms or keywords.
- Keep language simple and precise.
- For math/science: break into numbered logical steps.
- Always end with a brief "## Summary" section (2-3 lines max).
- Do NOT use markdown code blocks or backticks.
- Keep total response under 450 words.
`.trim();

        const answer = await callGroqAI(prompt);
        const cleanAnswer = answer.trim();

        // ── Save to DoubtLog ──────────────────────────────────────────
        const doubtLog = await DoubtLog.create({
            userId: req.user._id,
            instituteId: instituteId,
            courseId: courseId || null,
            question: question.trim(),
            answer: cleanAnswer,
            subject: subject || null,
            difficulty: difficulty || null,
            role: req.user?.role === 'student' ? 'student' : 'tutor',
        });

        // ── Log AI usage ──────────────────────────────────────────────
        logAIUsage(req.user._id, 'doubt_solver', {
            doubtLogId: doubtLog._id,
            subject: subject || 'General',
            difficulty: difficulty || 'unspecified',
            courseId: courseId || null,
        });

        res.status(200).json({
            success: true,
            doubtLogId: doubtLog._id,
            answer: cleanAnswer,
            question: question.trim(),
            subject: subject || null,
            difficulty: difficulty || null,
        });

    } catch (error) {
        console.error('Solve doubt error:', error);
        res.status(500).json({ success: false, message: 'Failed to solve doubt' });
    }
};

// @desc    Get doubt history for logged-in user
// @route   GET /api/ai/doubts
// @access  Private
// @query   page, limit, subject, courseId
export const getDoubtHistory = async (req, res) => {
    try {
        const { page = 1, limit = 20, subject, courseId } = req.query;

        const filter = { userId: req.user._id };
        if (subject) filter.subject = subject;
        if (courseId) filter.courseId = courseId;

        const skip = (Number(page) - 1) * Number(limit);
        const total = await DoubtLog.countDocuments(filter);

        const doubts = await DoubtLog.find(filter)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(Number(limit))
            .populate('courseId', 'title')
            .select('question subject difficulty rating createdAt courseId')
            .lean();

        // Format timeAgo
        const formatted = doubts.map(d => {
            const diffMs = Date.now() - new Date(d.createdAt).getTime();
            const diffMin = Math.floor(diffMs / 60000);
            const timeAgo = diffMin < 1 ? 'Just now'
                : diffMin < 60 ? `${diffMin}m ago`
                    : diffMin < 1440 ? `${Math.floor(diffMin / 60)}h ago`
                        : diffMin < 10080 ? `${Math.floor(diffMin / 1440)}d ago`
                            : new Date(d.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });

            return {
                _id: d._id,
                question: d.question,
                subject: d.subject,
                difficulty: d.difficulty,
                rating: d.rating,
                timeAgo,
                course: d.courseId?.title || null,
                createdAt: d.createdAt,
            };
        });

        res.status(200).json({
            success: true,
            total,
            page: Number(page),
            pages: Math.ceil(total / Number(limit)),
            doubts: formatted,
        });

    } catch (error) {
        console.error('Get doubt history error:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch doubt history' });
    }
};

// @desc    Get a single doubt with full answer
// @route   GET /api/ai/doubts/:id
// @access  Private
export const getDoubtById = async (req, res) => {
    try {
        const doubt = await DoubtLog.findOne({ _id: req.params.id, userId: req.user._id })
            .populate('courseId', 'title')
            .lean();

        if (!doubt) {
            return res.status(404).json({ success: false, message: 'Doubt not found' });
        }

        res.status(200).json({ success: true, doubt });
    } catch (error) {
        console.error('Get doubt by id error:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch doubt' });
    }
};

// @desc    Rate a doubt answer (1–5 stars)
// @route   PATCH /api/ai/doubts/:id/rate
// @access  Private
export const rateDoubt = async (req, res) => {
    try {
        const { rating } = req.body;

        if (!rating || rating < 1 || rating > 5) {
            return res.status(400).json({ success: false, message: 'Rating must be between 1 and 5' });
        }

        const doubt = await DoubtLog.findOneAndUpdate(
            { _id: req.params.id, userId: req.user._id },
            { rating: Number(rating) },
            { new: true }
        ).select('rating question subject');

        if (!doubt) {
            return res.status(404).json({ success: false, message: 'Doubt not found' });
        }

        res.status(200).json({ success: true, doubt });
    } catch (error) {
        console.error('Rate doubt error:', error);
        res.status(500).json({ success: false, message: 'Failed to rate doubt' });
    }
};

// @desc    Get distinct subjects from tutor's doubt history
//          + topics from Taxonomy
// @route   GET /api/ai/doubt-topics
// @access  Private
export const getDoubtTopics = async (req, res) => {
    try {
        // ── 1. Subjects from DoubtLog (distinct values for this user) ─
        const usedSubjects = await DoubtLog.distinct('subject', {
            userId: req.user._id,
            subject: { $ne: null },
        });

        // ── 2. Topics from Taxonomy (tutor's own topics) ──────────────
        let taxonomyTopics = [];
        try {
            const Tutor = (await import('../models/Tutor.js')).default;
            const Topic = (await import('../models/Topic.js')).default;

            const tutor = await Tutor.findOne({ userId: req.user._id }).select('_id').lean();
            if (tutor) {
                const topics = await Topic.find({ tutorId: tutor._id })
                    .select('name courseId')
                    .populate('courseId', 'title')
                    .sort({ name: 1 })
                    .lean();

                taxonomyTopics = topics.map(t => ({
                    name: t.name,
                    course: t.courseId?.title || null,
                }));
            }
        } catch { /* taxonomy is optional — proceed */ }

        // ── 3. Merge: taxonomy names + used subjects (deduplicated) ───
        const taxonomyNames = taxonomyTopics.map(t => t.name);
        const extraSubjects = usedSubjects.filter(s => !taxonomyNames.includes(s));

        res.status(200).json({
            success: true,
            topics: taxonomyTopics,          // full objects {name, course}
            usedSubjects: extraSubjects,           // subjects used in doubts but not in taxonomy
        });

    } catch (error) {
        console.error('Get doubt topics error:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch topics' });
    }
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function countWords(text = '') {
    return text.trim().split(/\s+/).filter(Boolean).length;
}

// Extract text from uploaded buffer based on mime type
async function extractTextFromBuffer(buffer, mimetype, originalname) {
    // DOCX
    if (
        mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
        originalname?.endsWith('.docx')
    ) {
        const result = await mammoth.extractRawText({ buffer });
        return result.value?.trim() || '';
    }

    // PDF
    if (mimetype === 'application/pdf' || originalname?.endsWith('.pdf')) {
        const result = await pdfParse(buffer);
        return result.text?.trim() || '';
    }

    // Plain text fallback
    return buffer.toString('utf-8').trim();
}

// @desc    Simplify notes using AI
// @route   POST /api/ai/simplify-notes
// @access  Private
// Body (multipart/form-data OR json):
//   text?        – raw notes text (if no file)
//   file?        – DOCX / PDF upload (field name: "file")
//   courseId?    – optional context
//   title?       – user label
export const simplifyNotes = async (req, res) => {
    try {
        if (!GROQ_API_KEY) {
            return res.status(500).json({ success: false, message: 'Groq API key not configured' });
        }

        // ── 1. Get input text (text body OR file) ─────────────────────
        let rawText = '';
        let sourceType = 'text';
        let sourceFileName = null;
        let sourceFileUrl = null;

        if (req.file) {
            // File uploaded via multer memory storage
            rawText = await extractTextFromBuffer(req.file.buffer, req.file.mimetype, req.file.originalname);
            sourceType = req.file.mimetype === 'application/pdf' ? 'pdf' : 'docx';
            sourceFileName = req.file.originalname;

            // Upload original file to Cloudinary for reference storage
            try {
                const { uploadToCloudinary } = await import('../utils/cloudinary.js');
                const uploaded = await uploadToCloudinary(
                    req.file.buffer,
                    'ai_notes/originals',
                    'raw'
                );
                sourceFileUrl = uploaded.secure_url;
            } catch { /* non-critical — proceed without URL */ }

        } else {
            rawText = (req.body.text || '').trim();
        }

        if (!rawText || rawText.length < 20) {
            return res.status(400).json({ success: false, message: 'Notes text (minimum 20 characters) or file upload is required.' });
        }

        const { courseId, title } = req.body;

        // ── 2. Optional course context ────────────────────────────────
        let courseContext = '';
        if (courseId) {
            try {
                const Course = (await import('../models/Course.js')).default;
                const course = await Course.findById(courseId).select('title level').lean();
                if (course) courseContext = `Course: "${course.title}" (${course.level} level)\n`;
            } catch { /* optional */ }
        }

        // ── 3. AI prompt ──────────────────────────────────────────────
        const originalWordCount = countWords(rawText);

        const prompt = `
You are an expert educational content simplifier. A tutor has provided detailed notes that need to be simplified for students.

${courseContext}
Original Notes:
"""
${rawText.slice(0, 6000)}
"""

Task:
1. Simplify the notes — clear, concise, easy to understand bullet points.
2. Retain ALL key concepts, formulas, and important facts.
3. Remove redundancy and jargon where possible.
4. Determine the appropriate grade level for the simplified content.

Return ONLY a valid JSON object (no markdown, no backticks):
{
  "title": "<auto-generate a short title from the content, max 6 words>",
  "gradeLevel": "<e.g. 8th Grade, 10th Grade, College Level>",
  "simplifiedText": "<the full simplified notes — use bullet points starting with •, use ## for headings>",
  "infoRetained": <integer 0-100 — estimated % of key information retained>
}
`.trim();

        const raw = await callGroqAI(prompt);

        // ── 4. Parse AI response ──────────────────────────────────────
        let parsed;
        try {
            const jsonStart = raw.indexOf('{');
            const jsonEnd = raw.lastIndexOf('}') + 1;
            parsed = JSON.parse(raw.slice(jsonStart, jsonEnd));
        } catch {
            return res.status(500).json({ success: false, message: 'AI returned invalid format. Try again later.' });
        }

        const simplifiedText = (parsed.simplifiedText || '').trim();
        const simplifiedWordCount = countWords(simplifiedText);
        const wordsReduced = Math.max(0, originalWordCount - simplifiedWordCount);
        const infoRetained = Math.min(100, Math.max(0, Number(parsed.infoRetained) || 90));
        const gradeLevel = parsed.gradeLevel || null;
        const autoTitle = title || parsed.title || 'Untitled Note';

        // ── 5. Get instituteId ────────────────────────────────────────
        let instituteId = null;
        try {
            const User = (await import('../models/User.js')).default;
            const user = await User.findById(req.user._id).select('instituteId').lean();
            instituteId = user?.instituteId || null;
        } catch { /* non-critical */ }

        // ── 6. Save to DB ─────────────────────────────────────────────
        const note = await SimplifiedNote.create({
            userId: req.user._id,
            instituteId,
            courseId: courseId || null,
            originalText: rawText,
            sourceType,
            sourceFileName,
            sourceFileUrl,
            simplifiedText,
            gradeLevel,
            originalWordCount,
            simplifiedWordCount,
            wordsReduced,
            infoRetained,
            title: autoTitle,
            sharedToCourses: [],
        });

        // ── 7. Log AI usage ───────────────────────────────────────────
        logAIUsage(req.user._id, 'summarize_lesson', {
            type: 'notes_simplifier',
            noteId: note._id,
            wordCount: originalWordCount,
            courseId: courseId || null,
        });

        res.status(200).json({
            success: true,
            note: {
                _id: note._id,
                title: autoTitle,
                simplifiedText,
                gradeLevel,
                originalWordCount,
                simplifiedWordCount,
                wordsReduced,
                infoRetained,
                sourceType,
                sourceFileName,
            },
        });

    } catch (error) {
        console.error('Simplify notes error:', error);
        res.status(500).json({ success: false, message: 'Failed to simplify notes' });
    }
};

// @desc    Get simplified notes history for logged-in tutor
// @route   GET /api/ai/simplified-notes
// @access  Private
// @query   page, limit, courseId
export const getSimplifiedNotes = async (req, res) => {
    try {
        const { page = 1, limit = 10, courseId } = req.query;
        const filter = { userId: req.user._id };
        if (courseId) filter.courseId = courseId;

        const skip = (Number(page) - 1) * Number(limit);
        const total = await SimplifiedNote.countDocuments(filter);

        const notes = await SimplifiedNote.find(filter)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(Number(limit))
            .populate('courseId', 'title')
            .select('-originalText -simplifiedText')   // exclude heavy fields from list
            .lean();

        const formatted = notes.map(n => {
            const diffMs = Date.now() - new Date(n.createdAt).getTime();
            const diffMin = Math.floor(diffMs / 60000);
            const timeAgo = diffMin < 1 ? 'Just now'
                : diffMin < 60 ? `${diffMin}m ago`
                    : diffMin < 1440 ? `${Math.floor(diffMin / 60)}h ago`
                        : diffMin < 10080 ? `${Math.floor(diffMin / 1440)}d ago`
                            : new Date(n.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });

            return { ...n, timeAgo, course: n.courseId?.title || null };
        });

        res.status(200).json({ success: true, total, page: Number(page), pages: Math.ceil(total / Number(limit)), notes: formatted });
    } catch (error) {
        console.error('Get simplified notes error:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch notes history' });
    }
};

// @desc    Get a single simplified note with full content
// @route   GET /api/ai/simplified-notes/:id
// @access  Private
export const getSimplifiedNoteById = async (req, res) => {
    try {
        const note = await SimplifiedNote.findOne({ _id: req.params.id, userId: req.user._id })
            .populate('courseId', 'title')
            .lean();
        if (!note) return res.status(404).json({ success: false, message: 'Note not found' });
        res.status(200).json({ success: true, note });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to fetch note' });
    }
};

// @desc    Share simplified note to a course as a lesson attachment
// @route   POST /api/ai/simplified-notes/:id/share
// @access  Private
// Body: { courseId, lessonId? }
export const shareNoteToCourse = async (req, res) => {
    try {
        const { courseId, lessonId } = req.body;

        if (!courseId) {
            return res.status(400).json({ success: false, message: 'courseId is required' });
        }

        // ── Verify note belongs to user ───────────────────────────────
        const note = await SimplifiedNote.findOne({ _id: req.params.id, userId: req.user._id });
        if (!note) return res.status(404).json({ success: false, message: 'Note not found' });

        // ── Verify tutor owns this course ─────────────────────────────
        const Tutor = (await import('../models/Tutor.js')).default;
        const Course = (await import('../models/Course.js')).default;
        const tutor = await Tutor.findOne({ userId: req.user._id }).select('_id').lean();
        if (!tutor) return res.status(403).json({ success: false, message: 'Tutor profile not found' });

        const course = await Course.findOne({ _id: courseId, tutorId: tutor._id });
        if (!course) return res.status(403).json({ success: false, message: 'Course not found or access denied' });

        // ── Convert simplified text to plain text blob & upload ───────
        // We upload simplified text as a raw .txt file to Cloudinary
        let cloudinaryUrl = null;
        let cloudinaryId = null;
        try {
            const textBuffer = Buffer.from(
                `${note.title}\n${'='.repeat(note.title.length)}\n\n${note.simplifiedText}`,
                'utf-8'
            );
            const { Readable } = await import('stream');
            const { v2: cloudinary } = await import('cloudinary');

            const uploadResult = await new Promise((resolve, reject) => {
                const stream = cloudinary.uploader.upload_stream(
                    { folder: 'ai_notes/simplified', resource_type: 'raw', public_id: `note_${note._id}`, overwrite: true },
                    (err, result) => err ? reject(err) : resolve(result)
                );
                Readable.from(textBuffer).pipe(stream);
            });

            cloudinaryUrl = uploadResult.secure_url;
            cloudinaryId = uploadResult.public_id;
        } catch (uploadErr) {
            console.error('Cloudinary upload for share failed:', uploadErr.message);
            // proceed without URL — attachment will have name only
        }

        // ── Push to lesson attachments (if lessonId provided) ─────────
        if (lessonId) {
            const Lesson = (await import('../models/Lesson.js')).default;
            const lesson = await Lesson.findOne({ _id: lessonId, courseId });
            if (lesson) {
                lesson.content.attachments = lesson.content.attachments || [];
                // Avoid duplicates
                const alreadyExists = lesson.content.attachments.some(a => a.url === cloudinaryUrl);
                if (!alreadyExists && cloudinaryUrl) {
                    lesson.content.attachments.push({
                        name: `[AI Note] ${note.title}.txt`,
                        url: cloudinaryUrl,
                        type: 'text/plain',
                    });
                    await lesson.save();
                }
            }
        }

        // ── Record share in SimplifiedNote ────────────────────────────
        const alreadyShared = note.sharedToCourses.some(s => s.courseId?.toString() === courseId);
        if (!alreadyShared) {
            note.sharedToCourses.push({ courseId, lessonId: lessonId || null, cloudinaryUrl, cloudinaryId });
            await note.save();
        }

        res.status(200).json({
            success: true,
            message: lessonId ? 'Note shared to lesson successfully' : 'Note shared to course successfully',
            cloudinaryUrl,
        });

    } catch (error) {
        console.error('Share note to course error:', error);
        res.status(500).json({ success: false, message: 'Failed to share note' });
    }
};

// @desc    Delete a simplified note
// @route   DELETE /api/ai/simplified-notes/:id
// @access  Private
export const deleteSimplifiedNote = async (req, res) => {
    try {
        const note = await SimplifiedNote.findOneAndDelete({ _id: req.params.id, userId: req.user._id });
        if (!note) return res.status(404).json({ success: false, message: 'Note not found' });
        res.status(200).json({ success: true, message: 'Note deleted' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to delete note' });
    }
};

// @desc    Get trending topics for Knowledge Bank
//          Uses: Taxonomy topics + most-used subjects in SimplifiedNotes
// @route   GET /api/ai/notes-knowledge-bank
// @access  Private
export const getNotesKnowledgeBank = async (req, res) => {
    try {
        // ── Trending: most-simplified subjects/topics ─────────────────
        const trending = await SimplifiedNote.aggregate([
            { $match: { userId: req.user._id, courseId: { $ne: null } } },
            { $group: { _id: '$courseId', count: { $sum: 1 } } },
            { $sort: { count: -1 } },
            { $limit: 8 },
            { $lookup: { from: 'courses', localField: '_id', foreignField: '_id', as: 'course' } },
            { $unwind: { path: '$course', preserveNullAndEmptyArrays: true } },
            { $project: { name: '$course.title', count: 1 } },
        ]);

        // ── Recently simplified note titles ───────────────────────────
        const recent = await SimplifiedNote.find({ userId: req.user._id })
            .sort({ createdAt: -1 })
            .limit(5)
            .select('title createdAt gradeLevel')
            .lean();

        // ── Taxonomy topics ───────────────────────────────────────────
        let taxonomyTopics = [];
        try {
            const Tutor = (await import('../models/Tutor.js')).default;
            const Topic = (await import('../models/Topic.js')).default;
            const tutor = await Tutor.findOne({ userId: req.user._id }).select('_id').lean();
            if (tutor) {
                taxonomyTopics = await Topic.find({ tutorId: tutor._id })
                    .select('name')
                    .sort({ name: 1 })
                    .limit(10)
                    .lean();
            }
        } catch { /* optional */ }

        res.status(200).json({
            success: true,
            trending: trending.map(t => t.name).filter(Boolean),
            recentTitles: recent,
            taxonomyTopics: taxonomyTopics.map(t => t.name),
        });

    } catch (error) {
        console.error('Knowledge bank error:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch knowledge bank' });
    }
};

// ── Helper: letter grade from percentage ─────────────────────────────────────
function getLetterGrade(pct) {
    if (pct >= 90) return 'A+';
    if (pct >= 85) return 'A';
    if (pct >= 80) return 'B+';
    if (pct >= 75) return 'B';
    if (pct >= 70) return 'C+';
    if (pct >= 60) return 'C';
    if (pct >= 50) return 'D';
    return 'F';
}

// ── Helper: run AI evaluation on a submission ─────────────────────────────────
async function runAIEvaluation(submission, assignment) {
    const rubricText = assignment.rubric?.length
        ? assignment.rubric.map(r => `- ${r.criterion} (${r.points} pts): ${r.description || ''}`).join('\n')
        : 'No rubric defined — evaluate holistically.';

    const prompt = `
You are an expert academic evaluator. Evaluate the following student assignment submission.

Assignment Title: "${assignment.title}"
Assignment Description: "${assignment.description || 'Not provided'}"
Total Marks: ${assignment.totalMarks}
Rubric:
${rubricText}

Student Submission:
"""
${(submission.content || '').slice(0, 4000) || '[No text content — attachments only]'}
"""

Evaluate thoroughly and return ONLY a valid JSON object (no markdown, no backticks):
{
  "grade": <number 0 to ${assignment.totalMarks}>,
  "percentage": <number 0 to 100>,
  "letterGrade": "<A+|A|B+|B|C+|C|D|F>",
  "overallFeedback": "<2-4 sentence overall assessment>",
  "strengths": ["<strength 1>", "<strength 2>", "<strength 3>"],
  "areasForImprovement": ["<area 1>", "<area 2>"],
  "rubricScores": [
    ${assignment.rubric?.map(r => `{"criterion": "${r.criterion}", "score": <0 to ${r.points}>, "maxScore": ${r.points}, "comment": "<1 sentence>"}`).join(',\n    ') || '{"criterion": "Overall", "score": 0, "maxScore": 100, "comment": ""}'}
  ],
  "detailedAnalysis": {
    "accuracy":           { "score": <0-100>, "label": "<short label>", "stars": <1-5> },
    "depthOfKnowledge":   { "score": <0-100>, "label": "<short label>", "stars": <1-5> },
    "clarity":            { "score": <0-100>, "label": "<short label>", "stars": <1-5> },
    "realWorldApplication": { "score": <0-100>, "label": "<short label>", "stars": <1-5> }
  }
}
`.trim();

    const raw = await callGroqAI(prompt);
    const jsonStart = raw.indexOf('{');
    const jsonEnd = raw.lastIndexOf('}') + 1;
    return JSON.parse(raw.slice(jsonStart, jsonEnd));
}

// @desc    Get tutor's assignments with submission stats (for evaluator list)
// @route   GET /api/ai/evaluator/assignments
// @access  Private (tutor)
export const getEvaluatorAssignments = async (req, res) => {
    try {
        const { courseId, page = 1, limit = 10 } = req.query;

        // Find tutor
        const Tutor = (await import('../models/Tutor.js')).default;
        const Course = (await import('../models/Course.js')).default;
        const tutor = await Tutor.findOne({ userId: req.user._id }).select('_id').lean();
        if (!tutor) return res.status(403).json({ success: false, message: 'Tutor profile not found' });

        // Get tutor's courses
        const courseFilter = { tutorId: tutor._id };
        if (courseId) courseFilter._id = courseId;
        const courses = await Course.find(courseFilter).select('_id title').lean();
        const courseIds = courses.map(c => c._id);

        const filter = { courseId: { $in: courseIds }, status: 'published' };
        const skip = (Number(page) - 1) * Number(limit);
        const total = await Assignment.countDocuments(filter);

        const assignments = await Assignment.find(filter)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(Number(limit))
            .populate('courseId', 'title')
            .lean();

        // Attach submission stats
        const assignmentIds = assignments.map(a => a._id);
        const subStats = await Submission.aggregate([
            { $match: { assignmentId: { $in: assignmentIds } } },
            {
                $group: {
                    _id: '$assignmentId',
                    total: { $sum: 1 },
                    graded: { $sum: { $cond: [{ $eq: ['$status', 'graded'] }, 1, 0] } },
                    pending: { $sum: { $cond: [{ $eq: ['$status', 'submitted'] }, 1, 0] } },
                    avgGrade: { $avg: { $cond: [{ $eq: ['$status', 'graded'] }, '$grade', null] } },
                },
            },
        ]);
        const statsMap = subStats.reduce((m, s) => { m[s._id.toString()] = s; return m; }, {});

        const enriched = assignments.map(a => ({
            ...a,
            stats: statsMap[a._id.toString()] || { total: 0, graded: 0, pending: 0, avgGrade: null },
        }));

        res.status(200).json({ success: true, total, page: Number(page), pages: Math.ceil(total / Number(limit)), assignments: enriched, courses });
    } catch (error) {
        console.error('getEvaluatorAssignments error:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch assignments' });
    }
};

// @desc    Get submissions for one assignment (with AI eval status)
// @route   GET /api/ai/evaluator/assignments/:assignmentId/submissions
// @access  Private (tutor)
export const getEvaluatorSubmissions = async (req, res) => {
    try {
        const { assignmentId } = req.params;

        const assignment = await Assignment.findById(assignmentId).lean();
        if (!assignment) return res.status(404).json({ success: false, message: 'Assignment not found' });

        const submissions = await Submission.find({ assignmentId })
            .populate('studentId', 'name email avatar')
            .sort({ submittedAt: -1 })
            .lean();

        // Format timeAgo for each
        const formatted = submissions.map(s => {
            const diffMs = Date.now() - new Date(s.submittedAt).getTime();
            const diffMin = Math.floor(diffMs / 60000);
            const timeAgo = diffMin < 60 ? `${diffMin}m ago`
                : diffMin < 1440 ? `${Math.floor(diffMin / 60)}h ago`
                    : `${Math.floor(diffMin / 1440)}d ago`;
            return { ...s, timeAgo };
        });

        res.status(200).json({ success: true, assignment, submissions: formatted });
    } catch (error) {
        console.error('getEvaluatorSubmissions error:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch submissions' });
    }
};

// @desc    AI evaluate a single submission (returns suggestion — does NOT save grade)
// @route   POST /api/ai/evaluator/submissions/:submissionId/evaluate
// @access  Private (tutor)
export const aiEvaluateSubmission = async (req, res) => {
    try {
        if (!GROQ_API_KEY) return res.status(500).json({ success: false, message: 'Groq API key not configured' });

        const submission = await Submission.findById(req.params.submissionId)
            .populate('studentId', 'name email avatar')
            .lean();
        if (!submission) return res.status(404).json({ success: false, message: 'Submission not found' });

        const assignment = await Assignment.findById(submission.assignmentId).lean();
        if (!assignment) return res.status(404).json({ success: false, message: 'Assignment not found' });

        const evaluation = await runAIEvaluation(submission, assignment);

        // Log usage
        logAIUsage(req.user._id, 'doubt_solver', {
            type: 'assignment_evaluator',
            submissionId: submission._id,
            assignmentId: assignment._id,
        });

        res.status(200).json({
            success: true,
            evaluation: {
                ...evaluation,
                submissionId: submission._id,
                studentName: submission.studentId?.name || 'Student',
                studentEmail: submission.studentId?.email || '',
                studentAvatar: submission.studentId?.avatar || null,
                submittedAt: submission.submittedAt,
                currentStatus: submission.status,
                currentGrade: submission.grade ?? null,
            },
        });
    } catch (error) {
        console.error('aiEvaluateSubmission error:', error);
        res.status(500).json({ success: false, message: 'AI evaluation failed' });
    }
};

// @desc    Confirm & save AI grade to submission
//          Tutor reviews AI suggestion then confirms — saves via gradeSubmission logic
// @route   POST /api/ai/evaluator/submissions/:submissionId/confirm-grade
// @access  Private (tutor)
export const confirmAIGrade = async (req, res) => {
    try {
        const { grade, feedback, rubricScores } = req.body;

        if (grade === undefined || grade === null) {
            return res.status(400).json({ success: false, message: 'grade is required' });
        }

        const submission = await Submission.findById(req.params.submissionId);
        if (!submission) return res.status(404).json({ success: false, message: 'Submission not found' });

        // Validate grade against assignment totalMarks
        const assignment = await Assignment.findById(submission.assignmentId).lean();
        const maxMarks = assignment?.totalMarks || 100;
        const finalGrade = Math.min(Number(grade), maxMarks);

        submission.status = 'graded';
        submission.grade = finalGrade;
        submission.feedback = feedback || '';
        submission.rubricScores = rubricScores || [];
        submission.gradedAt = new Date();
        submission.gradedBy = req.user._id;
        await submission.save();

        // Notify student
        try {
            const { createNotification } = await import('./notificationController.js');
            await createNotification({
                userId: submission.studentId,
                type: 'assignment_graded',
                title: 'Assignment Graded',
                message: `Your assignment has been graded. You scored ${finalGrade}/${maxMarks} marks.`,
                data: { courseId: submission.courseId, assignmentId: submission.assignmentId },
            });
        } catch { /* non-critical */ }

        res.status(200).json({ success: true, submission });
    } catch (error) {
        console.error('confirmAIGrade error:', error);
        res.status(500).json({ success: false, message: 'Failed to save grade' });
    }
};

// @desc    Bulk AI evaluate ALL pending submissions of an assignment
// @route   POST /api/ai/evaluator/assignments/:assignmentId/bulk-evaluate
// @access  Private (tutor)
export const bulkAIEvaluate = async (req, res) => {
    try {
        if (!GROQ_API_KEY) return res.status(500).json({ success: false, message: 'Groq API key not configured' });

        const assignment = await Assignment.findById(req.params.assignmentId).lean();
        if (!assignment) return res.status(404).json({ success: false, message: 'Assignment not found' });

        // Only evaluate ungraded submissions
        const submissions = await Submission.find({
            assignmentId: req.params.assignmentId,
            status: 'submitted',
        }).populate('studentId', 'name email').lean();

        if (submissions.length === 0) {
            return res.status(200).json({ success: true, message: 'No pending submissions to evaluate', results: [] });
        }

        // Evaluate sequentially to avoid rate limiting
        const results = [];
        for (const sub of submissions) {
            try {
                const evaluation = await runAIEvaluation(sub, assignment);
                results.push({
                    submissionId: sub._id,
                    studentName: sub.studentId?.name || 'Student',
                    studentEmail: sub.studentId?.email || '',
                    evaluation,
                    success: true,
                });
                // Small delay to avoid Groq rate limit
                await new Promise(r => setTimeout(r, 300));
            } catch (evalErr) {
                results.push({ submissionId: sub._id, success: false, error: evalErr.message });
            }
        }

        // Log bulk usage
        logAIUsage(req.user._id, 'doubt_solver', {
            type: 'bulk_assignment_evaluator',
            assignmentId: assignment._id,
            count: results.length,
        });

        res.status(200).json({ success: true, total: submissions.length, results });
    } catch (error) {
        console.error('bulkAIEvaluate error:', error);
        res.status(500).json({ success: false, message: 'Bulk evaluation failed' });
    }
};

// ── Helper: estimate minutes saved based on word count ────────────────────────
function estimateMinutesSaved(text = '') {
    const words = text.trim().split(/\s+/).filter(Boolean).length;
    // Average reading speed ~200wpm; summary saves ~70% of reading time
    return Math.round((words / 200) * 0.7);
}

// ── Helper: count pages (rough estimate from text length) ────────────────────
function estimatePages(text = '') {
    const words = text.trim().split(/\s+/).filter(Boolean).length;
    return Math.max(1, Math.round(words / 250)); // ~250 words per page
}

// @desc    Generate lecture summary (file / lesson / text / youtube)
// @route   POST /api/ai/lecture-summary/generate
// @access  Private (tutor)
// Body (multipart/form-data OR json):
//   lessonId?       – generate from existing lesson
//   text?           – pasted text
//   youtubeUrl?     – YouTube URL (title/description only — no transcript extraction)
//   file?           – PDF / DOCX / PPT upload (field: "file")
//   courseId?       – context
//   title?          – custom title
//   summaryLength   – 'short' | 'medium' | 'detailed'
//   focusAreas      – JSON array string
export const generateLectureSummary = async (req, res) => {
    try {
        if (!GROQ_API_KEY) {
            return res.status(500).json({ success: false, message: 'Groq API key not configured' });
        }

        let rawText = '';
        let sourceType = 'text';
        let sourceFileName = null;
        let sourceFileUrl = null;
        let title = req.body.title || 'Untitled Lecture';
        let pageCount = 0;

        const {
            lessonId,
            youtubeUrl,
            courseId,
            summaryLength = 'medium',
        } = req.body;

        let focusAreas = ['Key Concepts', 'Key Takeaways'];
        try {
            if (req.body.focusAreas) focusAreas = JSON.parse(req.body.focusAreas);
        } catch { /* use default */ }

        // ── 1. Source resolution ──────────────────────────────────────

        if (lessonId) {
            // From existing lesson
            const lesson = await Lesson.findById(lessonId);
            if (!lesson) return res.status(404).json({ success: false, message: 'Lesson not found' });
            title = req.body.title || lesson.title;
            rawText = `Title: ${lesson.title}\nDescription: ${lesson.description || ''}\nContent: ${lesson.content?.text || ''}`;
            sourceType = 'lesson';
            pageCount = 1;

        } else if (req.file) {
            // File upload
            rawText = await extractTextFromBuffer(req.file.buffer, req.file.mimetype, req.file.originalname);
            sourceType = req.file.mimetype === 'application/pdf' ? 'file' : 'file';
            sourceFileName = req.file.originalname;
            title = req.body.title || req.file.originalname.replace(/\.[^.]+$/, '');
            pageCount = estimatePages(rawText);

            // Upload to Cloudinary for reference
            try {
                const { Readable } = await import('stream');
                const { v2: cloudinary } = await import('cloudinary');
                const uploadResult = await new Promise((resolve, reject) => {
                    const stream = cloudinary.uploader.upload_stream(
                        { folder: 'lecture_summaries/originals', resource_type: 'raw' },
                        (err, result) => err ? reject(err) : resolve(result)
                    );
                    Readable.from(req.file.buffer).pipe(stream);
                });
                sourceFileUrl = uploadResult.secure_url;
            } catch { /* non-critical */ }

        } else if (youtubeUrl) {
            // YouTube — use title + URL as context (no transcript)
            sourceType = 'youtube';
            title = req.body.title || 'YouTube Lecture';
            rawText = `YouTube Lecture URL: ${youtubeUrl}\nTitle: ${title}\nGenerate a structured educational summary based on what this lecture likely covers given the title.`;
            pageCount = 0;

        } else if (req.body.text) {
            rawText = req.body.text.trim();
            title = req.body.title || 'Pasted Lecture Notes';
            pageCount = estimatePages(rawText);

        } else {
            return res.status(400).json({ success: false, message: 'Provide lessonId, file, youtubeUrl, or text' });
        }

        if (!rawText || rawText.length < 10) {
            return res.status(400).json({ success: false, message: 'Not enough content to summarize' });
        }

        // ── 2. Optional course context ────────────────────────────────
        let courseContext = '';
        if (courseId) {
            try {
                const Course = (await import('../models/Course.js')).default;
                const course = await Course.findById(courseId).select('title level').lean();
                if (course) courseContext = `Course: "${course.title}" (${course.level} level)\n`;
            } catch { /* optional */ }
        }

        // ── 3. Length instruction ─────────────────────────────────────
        const lengthGuide = summaryLength === 'short'
            ? 'Keep the summary very concise — max 100 words for summary, 3-4 key points.'
            : summaryLength === 'detailed'
                ? 'Be thorough and detailed — 300+ words for summary, 8-10 key points, comprehensive notes.'
                : 'Medium length — 150-200 words for summary, 5-6 key points.';

        const focusInstruction = focusAreas.length
            ? `Focus especially on: ${focusAreas.join(', ')}.`
            : '';

        // ── 4. AI prompt ──────────────────────────────────────────────
        const prompt = `
You are an expert educational content summarizer for a tutor platform.

${courseContext}
Lecture Title: "${title}"
${focusInstruction}
${lengthGuide}

Lecture Content:
"""
${rawText.slice(0, 6000)}
"""

Return ONLY a valid JSON object (no markdown, no backticks):
{
  "title": "<clean lecture title, max 8 words>",
  "summary": "<paragraph summary of the lecture>",
  "keyPoints": ["<point 1>", "<point 2>", "<point 3>", "<point 4>", "<point 5>"],
  "keyTakeaways": ["<takeaway 1>", "<takeaway 2>", "<takeaway 3>", "<takeaway 4>"],
  "studyNotes": "<structured study notes with ## headings and • bullet points>",
  "subject": "<inferred subject e.g. Physics, Mathematics>",
  "estimatedDuration": "<e.g. 45 min, 1 hr>",
  "difficulty": "<Beginner|Intermediate|Advanced>"
}
`.trim();

        const raw = await callGroqAI(prompt);

        // ── 5. Parse ──────────────────────────────────────────────────
        let parsed;
        try {
            const s = raw.indexOf('{'), e = raw.lastIndexOf('}') + 1;
            parsed = JSON.parse(raw.slice(s, e));
        } catch {
            return res.status(500).json({ success: false, message: 'AI returned invalid format. Try again later.' });
        }

        const minutesSaved = estimateMinutesSaved(rawText);
        const keyPointCount = (parsed.keyPoints || []).length;
        const finalTitle = parsed.title || title;

        // ── 6. Get instituteId ────────────────────────────────────────
        let instituteId = null;
        try {
            const User = (await import('../models/User.js')).default;
            const user = await User.findById(req.user._id).select('instituteId').lean();
            instituteId = user?.instituteId || null;
        } catch { /* non-critical */ }

        // ── 7. Save to DB ─────────────────────────────────────────────
        const record = await LectureSummary.create({
            userId: req.user._id,
            instituteId,
            courseId: courseId || null,
            lessonId: lessonId || null,
            title: finalTitle,
            sourceType,
            sourceFileName,
            sourceFileUrl,
            youtubeUrl: youtubeUrl || null,
            rawText: rawText.slice(0, 8000),
            summaryLength,
            focusAreas,
            summary: parsed.summary || '',
            keyPoints: parsed.keyPoints || [],
            keyTakeaways: parsed.keyTakeaways || [],
            studyNotes: parsed.studyNotes || '',
            pageCount,
            keyPointCount,
            minutesSaved,
            accuracy: 98,
            status: 'ready',
        });

        // ── 8. Log AI usage ───────────────────────────────────────────
        logAIUsage(req.user._id, 'summarize_lesson', {
            type: 'lecture_summary',
            recordId: record._id,
            lessonId: lessonId || null,
            courseId: courseId || null,
            sourceType,
        });

        res.status(200).json({
            success: true,
            record: {
                _id: record._id,
                title: finalTitle,
                summary: parsed.summary || '',
                keyPoints: parsed.keyPoints || [],
                keyTakeaways: parsed.keyTakeaways || [],
                studyNotes: parsed.studyNotes || '',
                subject: parsed.subject || null,
                estimatedDuration: parsed.estimatedDuration || null,
                difficulty: parsed.difficulty || null,
                pageCount,
                keyPointCount,
                minutesSaved,
                accuracy: 98,
                sourceType,
                sourceFileName,
                status: 'ready',
            },
        });

    } catch (error) {
        console.error('generateLectureSummary error:', error);
        res.status(500).json({ success: false, message: 'Failed to generate summary' });
    }
};

// @desc    Get lecture summary history
// @route   GET /api/ai/lecture-summaries
// @access  Private
export const getLectureSummaries = async (req, res) => {
    try {
        const { page = 1, limit = 10, courseId } = req.query;
        const filter = { userId: req.user._id, status: 'ready' };
        if (courseId) filter.courseId = courseId;

        const skip = (Number(page) - 1) * Number(limit);
        const total = await LectureSummary.countDocuments(filter);

        const records = await LectureSummary.find(filter)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(Number(limit))
            .populate('courseId', 'title')
            .populate('lessonId', 'title type')
            .select('-rawText -summary -studyNotes')
            .lean();

        const formatted = records.map(r => {
            const diffMs = Date.now() - new Date(r.createdAt).getTime();
            const diffMin = Math.floor(diffMs / 60000);
            const timeAgo = diffMin < 1 ? 'Just now'
                : diffMin < 60 ? `${diffMin}m ago`
                    : diffMin < 1440 ? `${Math.floor(diffMin / 60)}h ago`
                        : diffMin < 10080 ? `${Math.floor(diffMin / 1440)}d ago`
                            : new Date(r.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
            return { ...r, timeAgo, course: r.courseId?.title || null };
        });

        res.status(200).json({ success: true, total, page: Number(page), pages: Math.ceil(total / Number(limit)), records: formatted });
    } catch (error) {
        console.error('getLectureSummaries error:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch summaries' });
    }
};

// @desc    Get single lecture summary with full content
// @route   GET /api/ai/lecture-summaries/:id
// @access  Private
export const getLectureSummaryById = async (req, res) => {
    try {
        const record = await LectureSummary.findOne({ _id: req.params.id, userId: req.user._id })
            .populate('courseId', 'title')
            .populate('lessonId', 'title type')
            .lean();
        if (!record) return res.status(404).json({ success: false, message: 'Summary not found' });
        res.status(200).json({ success: true, record });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to fetch summary' });
    }
};

// @desc    Delete a lecture summary
// @route   DELETE /api/ai/lecture-summaries/:id
// @access  Private
export const deleteLectureSummary = async (req, res) => {
    try {
        const record = await LectureSummary.findOneAndDelete({ _id: req.params.id, userId: req.user._id });
        if (!record) return res.status(404).json({ success: false, message: 'Summary not found' });
        res.status(200).json({ success: true, message: 'Summary deleted' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to delete summary' });
    }
};

// @desc    Share lecture summary with course & notify students
// @route   PATCH /api/ai/lecture-summaries/:id/share
// @access  Private (tutor)
export const shareLectureSummary = async (req, res) => {
    try {
        const { courseId, notifyStudents } = req.body;
        const summaryId = req.params.id;

        const record = await LectureSummary.findOneAndUpdate(
            { _id: summaryId, userId: req.user._id },
            { courseId, status: 'ready' },
            { new: true }
        ).populate('courseId', 'title');

        if (!record) {
            return res.status(404).json({ success: false, message: 'Summary not found.' });
        }

        if (notifyStudents && courseId) {
            const Enrollment = (await import('../models/Enrollment.js')).default;
            const { createNotification } = await import('./notificationController.js');

            const enrollments = await Enrollment.find({ courseId, status: 'active' }).select('studentId').lean();
            const studentIds = enrollments.map(e => e.studentId);

            if (studentIds.length > 0) {
                const message = `Your tutor shared a new lecture summary: "${record.title}". View it in your AI Buddy tab.`;
                await Promise.all(studentIds.map(sId =>
                    createNotification({
                        userId: sId,
                        type: 'system_alert',
                        title: 'New Lecture Summary Shared 📝',
                        message
                    }).catch(err => console.error(`Error notifying student ${sId}:`, err))
                ));
            }
        }

        res.status(200).json({
            success: true,
            message: 'Lecture summary shared successfully!',
            record
        });
    } catch (error) {
        console.error('shareLectureSummary error:', error);
        res.status(500).json({ success: false, message: 'Failed to share lecture summary.' });
    }
};

// @desc    Get lecture summary stats for tutor
// @route   GET /api/ai/lecture-summary-stats
// @access  Private
export const getLectureSummaryStats = async (req, res) => {
    try {
        const userId = req.user._id;

        const [totalLectures, summariesGenerated, aggStats] = await Promise.all([
            // Total lessons taught by this tutor
            (async () => {
                try {
                    const Tutor = (await import('../models/Tutor.js')).default;
                    const Course = (await import('../models/Course.js')).default;
                    const tutor = await Tutor.findOne({ userId }).select('_id').lean();
                    if (!tutor) return 0;
                    const courses = await Course.find({ tutorId: tutor._id }).select('_id').lean();
                    const courseIds = courses.map(c => c._id);
                    return await Lesson.countDocuments({ courseId: { $in: courseIds } });
                } catch { return 0; }
            })(),

            LectureSummary.countDocuments({ userId, status: 'ready' }),

            LectureSummary.aggregate([
                { $match: { userId: req.user._id, status: 'ready' } },
                {
                    $group: {
                        _id: null,
                        totalMinutesSaved: { $sum: '$minutesSaved' },
                        avgAccuracy: { $avg: '$accuracy' },
                    }
                },
            ]),
        ]);

        const totalMinutesSaved = aggStats[0]?.totalMinutesSaved || 0;
        const avgAccuracy = aggStats[0]?.avgAccuracy?.toFixed(1) || '98.0';

        // AI Insights — topics students struggled with (from QuizAttempt low scores)
        let aiInsights = [];
        try {
            const Tutor = (await import('../models/Tutor.js')).default;
            const Course = (await import('../models/Course.js')).default;
            const tutor = await Tutor.findOne({ userId }).select('_id').lean();
            if (tutor) {
                const courses = await Course.find({ tutorId: tutor._id }).select('_id').lean();
                const courseIds = courses.map(c => c._id);
                const lessons = await Lesson.find({ courseId: { $in: courseIds } }).select('_id title').lean();
                const lessonIds = lessons.map(l => l._id);

                const lowScores = await QuizAttempt.aggregate([
                    { $match: { lessonId: { $in: lessonIds }, score: { $lt: 60 } } },
                    { $group: { _id: '$lessonId', avgScore: { $avg: '$score' }, count: { $sum: 1 } } },
                    { $sort: { avgScore: 1 } },
                    { $limit: 3 },
                ]);

                const lessonMap = lessons.reduce((m, l) => { m[l._id.toString()] = l.title; return m; }, {});
                aiInsights = lowScores.map(s => ({
                    lessonId: s._id,
                    title: lessonMap[s._id.toString()] || 'Unknown Lesson',
                    avgScore: Math.round(s.avgScore),
                    count: s.count,
                    message: `Students struggled with this topic (avg ${Math.round(s.avgScore)}%) — Review recommended!`,
                }));
            }
        } catch { /* non-critical */ }

        res.status(200).json({
            success: true,
            stats: {
                totalLectures,
                summariesGenerated,
                timeSaved: totalMinutesSaved >= 60
                    ? `${(totalMinutesSaved / 60).toFixed(1)} hrs`
                    : `${totalMinutesSaved} mins`,
                accuracy: `${avgAccuracy}%`,
            },
            aiInsights,
        });

    } catch (error) {
        console.error('getLectureSummaryStats error:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch stats' });
    }
};

// @desc    Get related lectures (same course, same lesson type)
// @route   GET /api/ai/lecture-summaries/:id/related
// @access  Private
export const getRelatedLectures = async (req, res) => {
    try {
        const current = await LectureSummary.findOne({ _id: req.params.id, userId: req.user._id })
            .select('courseId lessonId title')
            .lean();

        if (!current || !current.courseId) {
            return res.status(200).json({ success: true, lessons: [] });
        }

        // Get other lessons from the same course
        const lessons = await Lesson.find({
            courseId: current.courseId,
            _id: { $ne: current.lessonId },
            isPublished: true,
        })
            .select('title type content.duration')
            .limit(5)
            .lean();

        res.status(200).json({ success: true, lessons });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to fetch related lectures' });
    }
};

// @desc    Get weak topics analysis for tutor's students
// @route   GET /api/ai/weak-topics
// @access  Private (tutor)
// @query   courseId?, limit?
export const getWeakTopics = async (req, res) => {
    try {
        const { courseId, limit = 10 } = req.query;

        const Tutor = (await import('../models/Tutor.js')).default;
        const Course = (await import('../models/Course.js')).default;
        const User = (await import('../models/User.js')).default;
        const Topic = (await import('../models/Topic.js')).default;

        const tutor = await Tutor.findOne({ userId: req.user._id }).select('_id').lean();
        if (!tutor) return res.status(403).json({ success: false, message: 'Tutor profile not found' });

        const courseFilter = { tutorId: tutor._id };
        if (courseId) courseFilter._id = courseId;
        const courses = await Course.find(courseFilter).select('_id title').lean();
        const courseIds = courses.map(c => c._id);

        if (courseIds.length === 0) {
            return res.status(200).json({
                success: true,
                weakTopics: [], courseList: [], atRiskStudents: [],
                heatmap: { struggling: 0, atRisk: 0, caution: 0, onTrack: 0 },
                trendData: [], overallStats: { atRiskCount: 0, avgScore: 0, weakTopicCount: 0, totalStudents: 0 },
                aiRecommendations: null,
            });
        }

        // ── Lessons ───────────────────────────────────────────────────
        const lessons = await Lesson.find({ courseId: { $in: courseIds } })
            .select('_id title courseId').lean();
        const lessonIds = lessons.map(l => l._id);
        const lessonMap = lessons.reduce((m, l) => { m[l._id.toString()] = l; return m; }, {});

        // ── QuizAttempt aggregation per lesson ────────────────────────
        const quizAgg = await QuizAttempt.aggregate([
            { $match: { lessonId: { $in: lessonIds } } },
            {
                $group: {
                    _id: '$lessonId',
                    avgScore: { $avg: '$score' },
                    totalAttempts: { $sum: 1 },
                    passedCount: { $sum: { $cond: ['$isPassed', 1, 0] } },
                    failedCount: { $sum: { $cond: ['$isPassed', 0, 1] } },
                    minScore: { $min: '$score' },
                    maxScore: { $max: '$score' },
                    studentIds: { $addToSet: '$studentId' },
                },
            },
            { $sort: { avgScore: 1 } },
            { $limit: Number(limit) },
        ]);

        // ── Build weakTopics ──────────────────────────────────────────
        const weakTopics = quizAgg.map(q => {
            const lesson = lessonMap[q._id.toString()];
            const cId = lesson?.courseId?.toString();
            const course = courses.find(c => c._id.toString() === cId);
            const passRate = q.totalAttempts > 0 ? Math.round((q.passedCount / q.totalAttempts) * 100) : 0;
            const avgScore = Math.round(q.avgScore);
            const severity = avgScore < 40 ? 'critical' : avgScore < 60 ? 'warning' : 'moderate';
            const priority = avgScore < 40 ? 'High' : avgScore < 60 ? 'Medium' : 'Low';

            return {
                lessonId: q._id,
                lessonTitle: lesson?.title || 'Unknown Lesson',
                courseId: cId,
                courseTitle: course?.title || 'Unknown Course',
                avgScore,
                passRate,
                totalAttempts: q.totalAttempts,
                studentsImpacted: (q.studentIds || []).length,
                failedCount: q.failedCount,
                passedCount: q.passedCount,
                minScore: Math.round(q.minScore),
                maxScore: Math.round(q.maxScore),
                difficultyRank: q.totalAttempts,
                severity,
                priority,
                studentIds: q.studentIds || [],
            };
        }).filter(t => t.avgScore < 75);

        // ── Enrollment stats ──────────────────────────────────────────
        const enrollmentAgg = await Enrollment.aggregate([
            { $match: { courseId: { $in: courseIds }, status: 'active' } },
            {
                $group: {
                    _id: '$courseId',
                    totalStudents: { $sum: 1 },
                    avgProgress: { $avg: '$progress.percentage' },
                    studentIds: { $addToSet: '$studentId' },
                },
            },
        ]);
        const enrollmentMap = enrollmentAgg.reduce((m, e) => { m[e._id.toString()] = e; return m; }, {});

        const allStudentIds = [...new Set(
            enrollmentAgg.flatMap(e => e.studentIds.map(id => id.toString()))
        )];
        const totalStudents = allStudentIds.length;

        // ── Per-student weak score analysis ───────────────────────────
        // Get each student's avg score across all quiz attempts in tutor's courses
        const studentScoreAgg = await QuizAttempt.aggregate([
            { $match: { lessonId: { $in: lessonIds } } },
            {
                $group: {
                    _id: '$studentId',
                    avgScore: { $avg: '$score' },
                    totalAttempts: { $sum: 1 },
                    weakTopics: { $addToSet: '$lessonId' },
                },
            },
            { $sort: { avgScore: 1 } },
            { $limit: 20 },
        ]);

        // Fetch student user details
        const studentUserIds = studentScoreAgg.map(s => s._id);
        const studentUsers = await User.find({ _id: { $in: studentUserIds } })
            .select('_id name profileImage').lean();
        const studentUserMap = studentUsers.reduce((m, u) => { m[u._id.toString()] = u; return m; }, {});

        // Map weak lesson to topic name
        const weakLessonIds = [...new Set(weakTopics.map(t => t.lessonId.toString()))];

        // Build at-risk students (avg < 65%)
        const atRiskStudents = studentScoreAgg
            .filter(s => s.avgScore < 65)
            .slice(0, 8)
            .map(s => {
                const user = studentUserMap[s._id.toString()];
                const avgScore = Math.round(s.avgScore);

                // Find weakest topic for this student
                const studentWeakLesson = weakTopics.find(t =>
                    s.weakTopics.some(wl => wl.toString() === t.lessonId.toString())
                );
                const hoursSpent = Math.round((s.totalAttempts * 15) / 60 * 10) / 10; // rough estimate

                return {
                    studentId: s._id,
                    name: user?.name || 'Student',
                    avatar: user?.profileImage || null,
                    avgScore,
                    weakTopic: studentWeakLesson?.lessonTitle || 'Multiple Topics',
                    hoursSpent: `${hoursSpent} hrs`,
                    totalAttempts: s.totalAttempts,
                };
            });

        // ── Heatmap: classify all students ───────────────────────────
        // struggling <40, atRisk 40-59, caution 60-74, onTrack >=75
        let struggling = 0, atRisk = 0, caution = 0, onTrack = 0;
        studentScoreAgg.forEach(s => {
            if (s.avgScore < 40) struggling++;
            else if (s.avgScore < 60) atRisk++;
            else if (s.avgScore < 75) caution++;
            else onTrack++;
        });

        // Convert to percentages
        const heatmapTotal = struggling + atRisk + caution + onTrack || 1;
        const heatmap = {
            struggling: Math.round((struggling / heatmapTotal) * 100),
            atRisk: Math.round((atRisk / heatmapTotal) * 100),
            caution: Math.round((caution / heatmapTotal) * 100),
            onTrack: Math.round((onTrack / heatmapTotal) * 100),
        };

        // ── Monthly trend data (last 3 months) ────────────────────────
        const threeMonthsAgo = new Date();
        threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

        const trendAgg = await QuizAttempt.aggregate([
            {
                $match: {
                    lessonId: { $in: lessonIds },
                    createdAt: { $gte: threeMonthsAgo },
                },
            },
            {
                $group: {
                    _id: {
                        year: { $year: '$createdAt' },
                        month: { $month: '$createdAt' },
                    },
                    avgScore: { $avg: '$score' },
                    totalAttempts: { $sum: 1 },
                },
            },
            { $sort: { '_id.year': 1, '_id.month': 1 } },
        ]);

        const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const trendData = trendAgg.map(t => ({
            month: monthNames[t._id.month - 1],
            avgScore: Math.round(t.avgScore),
            attempts: t.totalAttempts,
        }));

        // Fill missing months if < 3 data points
        if (trendData.length < 2) {
            const now = new Date();
            for (let i = 2; i >= 0; i--) {
                const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
                const label = monthNames[d.getMonth()];
                if (!trendData.find(t => t.month === label)) {
                    trendData.splice(2 - i, 0, { month: label, avgScore: null, attempts: 0 });
                }
            }
        }

        // ── Course list for filter ────────────────────────────────────
        const courseList = courses.map(c => {
            const cId = c._id.toString();
            const enrl = enrollmentMap[cId] || {};
            const weakCount = weakTopics.filter(t => t.courseId === cId).length;
            return {
                _id: c._id,
                title: c.title,
                totalStudents: enrl.totalStudents || 0,
                avgProgress: Math.round(enrl.avgProgress || 0),
                weakCount,
                healthScore: Math.max(0, 100 - weakCount * 12),
            };
        });

        // ── Overall stats ─────────────────────────────────────────────
        const avgScore = studentScoreAgg.length > 0
            ? Math.round(studentScoreAgg.reduce((s, x) => s + x.avgScore, 0) / studentScoreAgg.length)
            : 0;

        // ── AI Recommendations ────────────────────────────────────────
        let aiRecommendations = null;
        if (weakTopics.length > 0 && GROQ_API_KEY) {
            try {
                const topList = weakTopics.slice(0, 4).map(t =>
                    `- "${t.lessonTitle}": avg ${t.avgScore}%, ${t.studentsImpacted} students impacted, pass rate ${t.passRate}%`
                ).join('\n');

                const prompt = `
You are an expert educational analyst. Students are struggling with:
${topList}

Return ONLY valid JSON (no markdown):
{
  "summary": "<2 sentence pattern overview>",
  "recommendations": [
    { "topic": "<lesson title>", "action": "<1 sentence specific action>" }
  ],
  "teachingStrategies": ["<strategy 1>", "<strategy 2>", "<strategy 3>"],
  "estimatedImprovementWeeks": <number>
}
`.trim();

                const raw = await callGroqAI(prompt);
                const s = raw.indexOf('{'), e = raw.lastIndexOf('}') + 1;
                aiRecommendations = JSON.parse(raw.slice(s, e));
            } catch { /* non-critical */ }
        }

        // ── Log & respond ─────────────────────────────────────────────
        logAIUsage(req.user._id, 'analytics', { type: 'weak_topics', weakCount: weakTopics.length });

        res.status(200).json({
            success: true,
            weakTopics,
            courseList,
            atRiskStudents,
            heatmap,
            trendData,
            aiRecommendations,
            overallStats: {
                atRiskCount: atRiskStudents.length,
                avgScore,
                weakTopicCount: weakTopics.length,
                totalStudents,
                criticalCount: weakTopics.filter(t => t.severity === 'critical').length,
            },
        });

    } catch (error) {
        console.error('getWeakTopics error:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch weak topics' });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// STUDY PLAN CONTROLLERS
// Append these to aiController.js
// Import StudyPlan at top: import StudyPlan from '../models/StudyPlan.js';
// ─────────────────────────────────────────────────────────────────────────────

// @desc    Get tutor's at-risk students for study plan selector
// @route   GET /api/ai/study-plan/students
// @access  Private (tutor)
export const getStudyPlanStudents = async (req, res) => {
    try {
        const { courseId } = req.query;

        const Tutor = (await import('../models/Tutor.js')).default;
        const Course = (await import('../models/Course.js')).default;
        const User = (await import('../models/User.js')).default;

        const tutor = await Tutor.findOne({ userId: req.user._id }).select('_id').lean();
        if (!tutor) return res.status(403).json({ success: false, message: 'Tutor profile not found' });

        const courseFilter = { tutorId: tutor._id };
        if (courseId) courseFilter._id = courseId;
        const courses = await Course.find(courseFilter).select('_id title').lean();
        const courseIds = courses.map(c => c._id);

        if (courseIds.length === 0) {
            return res.status(200).json({ success: true, students: [], courses: [] });
        }

        // Get lessons
        const lessons = await Lesson.find({ courseId: { $in: courseIds } }).select('_id courseId').lean();
        const lessonIds = lessons.map(l => l._id);

        // Get all enrolled students
        const enrollments = await Enrollment.find({ courseId: { $in: courseIds }, status: 'active' })
            .populate('studentId', 'name email profileImage')
            .lean();

        // Get quiz performance per student
        const quizAgg = await QuizAttempt.aggregate([
            { $match: { lessonId: { $in: lessonIds } } },
            {
                $group: {
                    _id: '$studentId',
                    avgScore: { $avg: '$score' },
                    totalAttempts: { $sum: 1 },
                    failedCount: { $sum: { $cond: ['$isPassed', 0, 1] } },
                    weakLessons: { $addToSet: '$lessonId' },
                },
            },
        ]);
        const quizMap = quizAgg.reduce((m, q) => { m[q._id.toString()] = q; return m; }, {});

        // Get weak lesson titles
        const lessonTitleMap = await Lesson.find({ _id: { $in: lessonIds } })
            .select('_id title').lean()
            .then(ls => ls.reduce((m, l) => { m[l._id.toString()] = l.title; return m; }, {}));

        // Deduplicate students
        const seen = new Set();
        const students = [];

        for (const enrl of enrollments) {
            const student = enrl.studentId;
            if (!student || seen.has(student._id?.toString())) continue;
            seen.add(student._id.toString());

            const quiz = quizMap[student._id.toString()];
            const avgScore = quiz ? Math.round(quiz.avgScore) : null;

            // Get weak topic names for this student
            const weakTopicNames = quiz?.weakLessons
                ?.map(wl => lessonTitleMap[wl.toString()])
                .filter(Boolean)
                .slice(0, 5) || [];

            const riskLevel = !avgScore ? 'unknown'
                : avgScore < 40 ? 'critical'
                    : avgScore < 60 ? 'high'
                        : avgScore < 75 ? 'medium'
                            : 'low';

            // Get course for this enrollment
            const enrolledCourse = courses.find(c => c._id.toString() === enrl.courseId?.toString());

            students.push({
                _id: student._id,
                name: student.name,
                email: student.email,
                avatar: student.profileImage || null,
                avgScore,
                riskLevel,
                weakTopics: weakTopicNames,
                totalAttempts: quiz?.totalAttempts || 0,
                failedCount: quiz?.failedCount || 0,
                course: enrolledCourse?.title || null,
                courseId: enrl.courseId,
                progress: enrl.progress?.percentage || 0,
            });
        }

        // Sort by risk (critical first)
        const riskOrder = { critical: 0, high: 1, medium: 2, low: 3, unknown: 4 };
        students.sort((a, b) => (riskOrder[a.riskLevel] || 4) - (riskOrder[b.riskLevel] || 4));

        res.status(200).json({ success: true, students, courses });

    } catch (error) {
        console.error('getStudyPlanStudents error:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch students' });
    }
};

const buildFallbackStudyPlan = ({
    studentName,
    weakTopics = [],
    durationWeeks = 2,
    hoursPerDay = 2,
    difficulty = 'moderate',
}) => {
    const totalDays = Math.min(Number(durationWeeks || 2) * 7, 14);
    const dayNames = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    const safeTopics = weakTopics.length ? weakTopics : ['Core concepts revision', 'Practice questions', 'Weekly assessment'];
    const minutes = Number(hoursPerDay || 2) * 60;

    const weeklyPlan = Array.from({ length: totalDays }).map((_, index) => {
        const topic = safeTopics[index % safeTopics.length];
        const isQuizDay = index % 5 === 4;
        const isRevisionDay = index % 3 === 2;
        return {
            day: dayNames[index % 7],
            date: `Day ${index + 1}`,
            focus: isQuizDay ? 'Assessment Checkpoint' : isRevisionDay ? 'Revision and Recall' : 'Concept Building',
            totalMinutes: minutes,
            topics: [
                {
                    title: isQuizDay ? `${topic} checkpoint quiz` : `${topic} concept session`,
                    duration: `${Math.max(30, Math.round(minutes * 0.45))} mins`,
                    type: isQuizDay ? 'quiz' : 'study',
                    description: isQuizDay
                        ? `Attempt a short quiz and mark mistakes for tutor review.`
                        : `Review the core ideas of ${topic} and write a one-page summary.`,
                    resources: ['Course lesson notes', 'Tutor-provided examples'],
                },
                {
                    title: `${topic} practice block`,
                    duration: `${Math.max(25, Math.round(minutes * 0.35))} mins`,
                    type: isRevisionDay ? 'revision' : 'practice',
                    description: `Solve targeted questions and list unresolved doubts.`,
                    resources: ['Practice MCQs', 'Previous class examples'],
                },
                {
                    title: 'Reflection and doubt log',
                    duration: `${Math.max(10, Math.round(minutes * 0.20))} mins`,
                    type: 'revision',
                    description: 'Record confidence score, doubts, and next-day priority.',
                    resources: ['Study journal'],
                },
            ],
        };
    });

    return {
        title: `${studentName || 'Student'} Recovery Plan`,
        goal: `Build consistency and improve weak areas through a structured ${durationWeeks}-week routine.`,
        summary: `This plan balances concept review, practice, revision, and checkpoints for ${difficulty} intensity.`,
        estimatedScore: difficulty === 'intensive' ? 18 : difficulty === 'easy' ? 8 : 12,
        keyMilestones: [
            'Complete the first revision cycle',
            'Attempt checkpoint quizzes without skipping',
            'Share unresolved doubts with the tutor weekly',
        ],
        weeklyPlan,
    };
};

// @desc    Generate AI study plan for a student
// @route   POST /api/ai/study-plan/generate
// @access  Private (tutor)
// Body: { studentId, weakTopics[], durationWeeks, hoursPerDay, difficulty, courseId? }
export const generateStudyPlan = async (req, res) => {
    try {
        const {
            studentId,
            weakTopics = [],
            durationWeeks = 2,
            hoursPerDay = 2,
            difficulty = 'moderate',
            courseId,
        } = req.body;

        if (!studentId) return res.status(400).json({ success: false, message: 'studentId is required' });

        const Tutor = (await import('../models/Tutor.js')).default;
        const User = (await import('../models/User.js')).default;
        const StudyPlan = (await import('../models/StudyPlan.js')).default;
        const Course = (await import('../models/Course.js')).default;

        const tutor = await Tutor.findOne({ userId: req.user._id }).select('_id').lean();
        if (!tutor) return res.status(403).json({ success: false, message: 'Tutor profile not found' });

        const student = await User.findById(studentId).select('name email instituteId').lean();
        if (!student) return res.status(404).json({ success: false, message: 'Student not found' });

        let resolvedWeakTopics = Array.isArray(weakTopics)
            ? weakTopics.map(t => String(t || '').trim()).filter(Boolean)
            : [];

        if (resolvedWeakTopics.length === 0 && courseId) {
            const lessons = await Lesson.find({ courseId }).select('title').sort({ order: 1 }).limit(5).lean();
            resolvedWeakTopics = lessons.map(lesson => lesson.title).filter(Boolean);
        }
        if (resolvedWeakTopics.length === 0) {
            resolvedWeakTopics = ['Core concepts revision', 'Practice questions', 'Weekly assessment'];
        }

        // Optional course context
        let courseContext = '';
        if (courseId) {
            try {
                const course = await Course.findById(courseId).select('title level').lean();
                if (course) courseContext = `Course: "${course.title}" (${course.level} level)`;
            } catch { /* optional */ }
        }

        const totalDays = durationWeeks * 7;
        const weeklyHours = hoursPerDay * 7;

        // ── AI Prompt ─────────────────────────────────────────────────
        const prompt = `
You are an expert educational planner. Create a detailed personalized study plan.

Student: ${student.name}
Weak Topics: ${resolvedWeakTopics.join(', ')}
${courseContext}
Duration: ${durationWeeks} week(s) (${totalDays} days)
Daily Study Time: ${hoursPerDay} hours/day
Difficulty Level: ${difficulty}

Create a structured ${durationWeeks}-week study plan. Each day should have specific topic sessions.

Return ONLY valid JSON (no markdown, no backticks, no comments, no trailing commas):
{
  "title": "<short plan title, max 8 words>",
  "goal": "<1-2 sentence goal statement for this student>",
  "summary": "<2-3 sentence overview of the plan strategy>",
  "estimatedScore": <projected score improvement as integer 0-100>,
  "keyMilestones": ["<milestone 1>", "<milestone 2>", "<milestone 3>"],
  "weeklyPlan": [
    {
      "day": "Monday",
      "date": "Day 1",
      "focus": "<focus theme e.g. Concept Building>",
      "totalMinutes": <total minutes as integer>,
      "topics": [
        {
          "title": "<topic/activity title>",
          "duration": "<e.g. 45 mins>",
          "type": "<study|practice|revision|quiz|break>",
          "description": "<1 sentence what to do>",
          "resources": ["<resource 1>", "<resource 2>"]
        }
      ]
    }
  ]
}

Rules:
- Generate exactly ${Math.min(totalDays, 14)} days in weeklyPlan
- Distribute weak topics across the days logically
- Include revision days and quiz days
- Mix study, practice, revision, quiz, break types
- Keep totalMinutes realistic (= hoursPerDay * 60 = ${hoursPerDay * 60} per day)
- Resources should be specific (e.g. "Khan Academy: Newton's Laws video", "Practice MCQs on topic")
`.trim();

        let parsed;
        if (GROQ_API_KEY) {
            const raw = await callGroqAI(prompt);
            try {
                let jsonStr = raw;
                const s = jsonStr.indexOf('{');
                const e = jsonStr.lastIndexOf('}') + 1;
                if (s !== -1 && e !== 0) {
                    jsonStr = jsonStr.slice(s, e);
                }
                // Cleanup common markdown codeblock wrappers in case LLM ignores the rule
                jsonStr = jsonStr.replace(/```json/gi, '').replace(/```/g, '').trim();
                parsed = JSON.parse(jsonStr);
            } catch (err) {
                console.error('Failed to parse AI study plan JSON. Raw output:', raw);
                return res.status(500).json({ success: false, message: 'AI returned invalid format. Try again later.' });
            }
        } else {
            parsed = buildFallbackStudyPlan({
                studentName: student.name,
                weakTopics: resolvedWeakTopics,
                durationWeeks,
                hoursPerDay,
                difficulty,
            });
        }

        // ── Compute stats ─────────────────────────────────────────────
        const weeklyPlan = parsed.weeklyPlan || [];
        const totalStudyMins = weeklyPlan.reduce((s, d) => s + (d.totalMinutes || 0), 0);
        const totalStudyHours = Math.round(totalStudyMins / 60 * 10) / 10;
        const topicsCount = weeklyPlan.reduce((s, d) => s + (d.topics?.length || 0), 0);

        // ── Save to DB ────────────────────────────────────────────────
        const plan = await StudyPlan.create({
            tutorId: tutor._id,
            studentId,
            courseId: courseId || null,
            instituteId: student.instituteId || null,
            title: parsed.title || `${student.name}'s Study Plan`,
            studentName: student.name,
            weakTopics: resolvedWeakTopics,
            durationWeeks: Number(durationWeeks),
            hoursPerDay: Number(hoursPerDay),
            difficulty,
            goal: parsed.goal || '',
            summary: parsed.summary || '',
            keyMilestones: parsed.keyMilestones || [],
            estimatedScore: parsed.estimatedScore || null,
            weeklyPlan,
            totalDays: weeklyPlan.length,
            totalStudyHours,
            topicsCount,
            status: 'active',
        });

        // ── Log AI usage ──────────────────────────────────────────────
        logAIUsage(req.user._id, 'analytics', {
            type: 'study_plan',
            planId: plan._id,
            studentId,
            weakTopics: resolvedWeakTopics,
        });

        const { createNotification } = await import('./notificationController.js');
        await createNotification({
            userId: studentId,
            type: 'study_plan_generated',
            title: 'New study plan assigned',
            message: `${req.user.name || 'Your tutor'} assigned a personalized study plan: ${plan.title}`,
            data: { courseId: courseId || undefined, extras: { planId: plan._id } },
        });

        res.status(200).json({
            success: true,
            plan: {
                _id: plan._id,
                title: plan.title,
                studentName: plan.studentName,
                goal: plan.goal,
                summary: plan.summary,
                keyMilestones: plan.keyMilestones,
                estimatedScore: plan.estimatedScore,
                weeklyPlan: plan.weeklyPlan,
                totalDays: plan.totalDays,
                totalStudyHours: plan.totalStudyHours,
                topicsCount: plan.topicsCount,
                durationWeeks: plan.durationWeeks,
                hoursPerDay: plan.hoursPerDay,
                difficulty: plan.difficulty,
                weakTopics: plan.weakTopics,
                createdAt: plan.createdAt,
            },
        });

    } catch (error) {
        console.error('generateStudyPlan error:', error);
        res.status(500).json({ success: false, message: 'Failed to generate study plan' });
    }
};

// @desc    Get all study plans created by tutor
// @route   GET /api/ai/study-plans
// @access  Private (tutor)
export const getStudyPlans = async (req, res) => {
    try {
        const { page = 1, limit = 10, studentId, status } = req.query;

        const Tutor = (await import('../models/Tutor.js')).default;
        const StudyPlan = (await import('../models/StudyPlan.js')).default;

        const tutor = await Tutor.findOne({ userId: req.user._id }).select('_id').lean();
        if (!tutor) return res.status(403).json({ success: false, message: 'Tutor profile not found' });

        const filter = { tutorId: tutor._id };
        if (studentId) filter.studentId = studentId;
        if (status) filter.status = status;

        const skip = (Number(page) - 1) * Number(limit);
        const total = await StudyPlan.countDocuments(filter);

        const plans = await StudyPlan.find(filter)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(Number(limit))
            .populate('studentId', 'name profileImage email')
            .populate('courseId', 'title')
            .select('-weeklyPlan') // exclude heavy field from list
            .lean();

        const formatted = plans.map(p => {
            const diffMs = Date.now() - new Date(p.createdAt).getTime();
            const diffMin = Math.floor(diffMs / 60000);
            const timeAgo = diffMin < 1 ? 'Just now'
                : diffMin < 60 ? `${diffMin}m ago`
                    : diffMin < 1440 ? `${Math.floor(diffMin / 60)}h ago`
                        : diffMin < 10080 ? `${Math.floor(diffMin / 1440)}d ago`
                            : new Date(p.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });

            return {
                ...p,
                timeAgo,
                studentName: p.studentId?.name || p.studentName || 'Student',
                studentAvatar: p.studentId?.profileImage || null,
                course: p.courseId?.title || null,
            };
        });

        res.status(200).json({
            success: true,
            total,
            page: Number(page),
            pages: Math.ceil(total / Number(limit)),
            plans: formatted,
        });

    } catch (error) {
        console.error('getStudyPlans error:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch study plans' });
    }
};

// @desc    Get single study plan with full weeklyPlan
// @route   GET /api/ai/study-plans/:id
// @access  Private (tutor)
export const getStudyPlanById = async (req, res) => {
    try {
        const Tutor = (await import('../models/Tutor.js')).default;
        const StudyPlan = (await import('../models/StudyPlan.js')).default;

        const tutor = await Tutor.findOne({ userId: req.user._id }).select('_id').lean();
        if (!tutor) return res.status(403).json({ success: false, message: 'Tutor profile not found' });

        const plan = await StudyPlan.findOne({ _id: req.params.id, tutorId: tutor._id })
            .populate('studentId', 'name profileImage email')
            .populate('courseId', 'title')
            .lean();

        if (!plan) return res.status(404).json({ success: false, message: 'Study plan not found' });

        res.status(200).json({ success: true, plan });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to fetch study plan' });
    }
};

// @desc    Delete a study plan
// @route   DELETE /api/ai/study-plans/:id
// @access  Private (tutor)
export const deleteStudyPlan = async (req, res) => {
    try {
        const Tutor = (await import('../models/Tutor.js')).default;
        const StudyPlan = (await import('../models/StudyPlan.js')).default;

        const tutor = await Tutor.findOne({ userId: req.user._id }).select('_id').lean();
        if (!tutor) return res.status(403).json({ success: false, message: 'Tutor profile not found' });

        const plan = await StudyPlan.findOneAndDelete({ _id: req.params.id, tutorId: tutor._id });
        if (!plan) return res.status(404).json({ success: false, message: 'Study plan not found' });

        res.status(200).json({ success: true, message: 'Study plan deleted' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to delete study plan' });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// RISK PREDICTOR CONTROLLER
// ─────────────────────────────────────────────────────────────────────────────

// @desc    Get AI-assessed risk prediction for all students of a tutor
// @route   GET /api/ai/risk-predictor
// @access  Private (tutor)
// @query   courseId?, limit?
export const getRiskPrediction = async (req, res) => {
    try {
        const { courseId, limit = 30 } = req.query;

        const Tutor = (await import('../models/Tutor.js')).default;
        const Course = (await import('../models/Course.js')).default;
        const User = (await import('../models/User.js')).default;

        const tutor = await Tutor.findOne({ userId: req.user._id }).select('_id').lean();
        if (!tutor) return res.status(403).json({ success: false, message: 'Tutor profile not found' });

        const courseFilter = { tutorId: tutor._id };
        if (courseId) courseFilter._id = courseId;
        const courses = await Course.find(courseFilter).select('_id title').lean();
        const courseIds = courses.map(c => c._id);

        if (courseIds.length === 0) {
            return res.status(200).json({
                success: true,
                students: [],
                riskSummary: { high: 0, medium: 0, low: 0, total: 0 },
                recentAlerts: [],
                dropoutPrediction: 0,
                heatmap: { struggling: 0, atRisk: 0, caution: 0, onTrack: 0 },
                courseList: [],
                aiRecommendations: [],
            });
        }

        // ── Lessons for these courses ─────────────────────────────────
        const lessons = await Lesson.find({ courseId: { $in: courseIds } }).select('_id title courseId').lean();
        const lessonIds = lessons.map(l => l._id);
        const lessonMap = lessons.reduce((m, l) => { m[l._id.toString()] = l; return m; }, {});

        // ── Enrollments ───────────────────────────────────────────────
        const enrollments = await Enrollment.find({ courseId: { $in: courseIds }, status: 'active' })
            .lean();
        const enrollMap = {};
        enrollments.forEach(e => {
            const sId = e.studentId.toString();
            if (!enrollMap[sId]) enrollMap[sId] = [];
            enrollMap[sId].push(e);
        });
        const allStudentIds = [...new Set(enrollments.map(e => e.studentId))];

        if (allStudentIds.length === 0) {
            return res.status(200).json({
                success: true,
                students: [],
                riskSummary: { high: 0, medium: 0, low: 0, total: 0 },
                recentAlerts: [],
                dropoutPrediction: 0,
                heatmap: { struggling: 0, atRisk: 0, caution: 0, onTrack: 0 },
                courseList: courses.map(c => ({ _id: c._id, title: c.title })),
                aiRecommendations: [],
            });
        }

        // ── Quiz performance per student ──────────────────────────────
        const quizAgg = await QuizAttempt.aggregate([
            { $match: { lessonId: { $in: lessonIds }, studentId: { $in: allStudentIds } } },
            {
                $group: {
                    _id: '$studentId',
                    avgScore: { $avg: '$score' },
                    totalAttempts: { $sum: 1 },
                    failedCount: { $sum: { $cond: ['$isPassed', 0, 1] } },
                    passedCount: { $sum: { $cond: ['$isPassed', 1, 0] } },
                    weakLessons: { $addToSet: { $cond: [{ $eq: ['$isPassed', false] }, '$lessonId', null] } },
                    lastAttempt: { $max: '$createdAt' },
                },
            },
        ]);
        const quizMap = quizAgg.reduce((m, q) => { m[q._id.toString()] = q; return m; }, {});

        // ── Assignment submissions per student ────────────────────────
        const assignmentIds = await (await import('../models/Assignment.js')).default
            .find({ courseId: { $in: courseIds }, status: 'published' })
            .select('_id').lean()
            .then(as => as.map(a => a._id));

        const submissionAgg = await Submission.aggregate([
            { $match: { assignmentId: { $in: assignmentIds }, studentId: { $in: allStudentIds } } },
            {
                $group: {
                    _id: '$studentId',
                    totalSubmitted: { $sum: 1 },
                    avgGrade: { $avg: { $cond: [{ $eq: ['$status', 'graded'] }, '$grade', null] } },
                    lateCount: { $sum: { $cond: [{ $gt: ['$submittedAt', '$createdAt'] }, 1, 0] } },
                    ungradedCount: { $sum: { $cond: [{ $eq: ['$status', 'submitted'] }, 1, 0] } },
                },
            },
        ]);
        const submissionMap = submissionAgg.reduce((m, s) => { m[s._id.toString()] = s; return m; }, {});

        // ── Fetch user details ────────────────────────────────────────
        const users = await User.find({ _id: { $in: allStudentIds } })
            .select('_id name email profileImage').lean();
        const userMap = users.reduce((m, u) => { m[u._id.toString()] = u; return m; }, {});

        // ── Compute risk score per student ────────────────────────────
        // Risk score = weighted sum (0–100, higher = more at risk)
        // Factors: quiz avg (40%), pass rate (20%), progress (20%), submission rate (20%)
        const totalAssignments = assignmentIds.length || 1;

        const students = allStudentIds.map(sId => {
            const sid = sId.toString();
            const user = userMap[sid];
            const quiz = quizMap[sid];
            const sub = submissionMap[sid];
            const enrls = enrollMap[sid] || [];

            // Quiz metrics
            const avgScore = quiz ? Math.round(quiz.avgScore) : 0;
            const passRate = quiz ? Math.round((quiz.passedCount / quiz.totalAttempts) * 100) : 0;
            const quizEngaged = !!quiz;

            // Progress metrics
            const avgProgress = enrls.length > 0
                ? Math.round(enrls.reduce((s, e) => s + (e.progress?.percentage || 0), 0) / enrls.length)
                : 0;

            // Submission metrics
            const submissionRate = sub ? Math.round((sub.totalSubmitted / totalAssignments) * 100) : 0;
            const avgGrade = sub?.avgGrade ? Math.round(sub.avgGrade) : null;

            // ── Risk score calculation (0-100) ────────────────────────
            // Low quiz score → high risk
            const quizRiskComponent = quizEngaged ? Math.max(0, 100 - avgScore) : 70;
            const passRateRiskComponent = quizEngaged ? Math.max(0, 100 - passRate) : 60;
            const progressRiskComponent = Math.max(0, 100 - avgProgress);
            const submissionRiskComponent = Math.max(0, 100 - Math.min(submissionRate, 100));

            const riskScore = Math.round(
                quizRiskComponent * 0.35 +
                passRateRiskComponent * 0.25 +
                progressRiskComponent * 0.20 +
                submissionRiskComponent * 0.20
            );

            // ── Risk level ────────────────────────────────────────────
            const riskLevel = riskScore >= 65 ? 'high'
                : riskScore >= 40 ? 'medium'
                    : 'low';

            // ── Dropout risk % ────────────────────────────────────────
            // Based on: low progress + low quiz engagement + low submission
            let dropoutScore = 0;
            if (avgProgress < 20) dropoutScore += 30;
            if (!quizEngaged) dropoutScore += 25;
            if (submissionRate < 30) dropoutScore += 25;
            if (avgScore < 40) dropoutScore += 20;
            const dropoutRisk = Math.min(100, dropoutScore);

            // ── Key risk factors ──────────────────────────────────────
            const keyFactors = [];
            if (avgScore < 60 && quizEngaged) keyFactors.push('Low Grades');
            if (passRate < 50 && quizEngaged) keyFactors.push('Low Pass Rate');
            if (!quizEngaged) keyFactors.push('No Quiz Attempts');
            if (avgProgress < 40) keyFactors.push('Low Engagement');
            if (submissionRate < 50) keyFactors.push('Missing Assignments');
            if (avgGrade != null && avgGrade < 50) keyFactors.push('Poor Assignment Grades');

            // Weak topics
            const weakTopicNames = (quiz?.weakLessons || [])
                .filter(Boolean)
                .map(wl => lessonMap[wl.toString()]?.title)
                .filter(Boolean)
                .slice(0, 3);

            if (weakTopicNames.length > 0) keyFactors.push(`Weak Topics: ${weakTopicNames.slice(0, 2).join(', ')}`);

            // Course name
            const primaryEnrollment = enrls[0];
            const primaryCourse = courses.find(c => c._id.toString() === primaryEnrollment?.courseId?.toString());

            return {
                studentId: sId,
                name: user?.name || 'Unknown Student',
                email: user?.email || '',
                avatar: user?.profileImage || null,
                riskScore,
                riskLevel,
                dropoutRisk,
                avgScore: quizEngaged ? avgScore : null,
                passRate: quizEngaged ? passRate : null,
                avgProgress,
                submissionRate,
                avgGrade,
                keyFactors: keyFactors.slice(0, 4),
                weakTopics: weakTopicNames,
                quizEngaged,
                course: primaryCourse?.title || null,
                courseId: primaryEnrollment?.courseId || null,
                totalAttempts: quiz?.totalAttempts || 0,
            };
        })
            .filter(s => !!userMap[s.studentId.toString()]) // only known users
            .sort((a, b) => b.riskScore - a.riskScore)
            .slice(0, Number(limit));

        // ── Risk summary ──────────────────────────────────────────────
        const highCount = students.filter(s => s.riskLevel === 'high').length;
        const mediumCount = students.filter(s => s.riskLevel === 'medium').length;
        const lowCount = students.filter(s => s.riskLevel === 'low').length;
        const total = students.length;

        const riskSummary = {
            high: highCount,
            medium: mediumCount,
            low: lowCount,
            total,
            highPct: total > 0 ? Math.round((highCount / total) * 100) : 0,
            mediumPct: total > 0 ? Math.round((mediumCount / total) * 100) : 0,
            lowPct: total > 0 ? Math.round((lowCount / total) * 100) : 0,
        };

        // ── Heatmap ───────────────────────────────────────────────────
        const struggling = students.filter(s => s.riskScore >= 75).length;
        const atRisk = students.filter(s => s.riskScore >= 55 && s.riskScore < 75).length;
        const caution = students.filter(s => s.riskScore >= 35 && s.riskScore < 55).length;
        const onTrack = students.filter(s => s.riskScore < 35).length;
        const hmTotal = total || 1;

        const heatmap = {
            struggling: Math.round((struggling / hmTotal) * 100),
            atRisk: Math.round((atRisk / hmTotal) * 100),
            caution: Math.round((caution / hmTotal) * 100),
            onTrack: Math.round((onTrack / hmTotal) * 100),
            strugglingCount: struggling,
            atRiskCount: atRisk,
            cautionCount: caution,
            onTrackCount: onTrack,
        };

        // ── Overall dropout prediction ────────────────────────────────
        const dropoutPrediction = students.length > 0
            ? Math.round(students.reduce((s, st) => s + st.dropoutRisk, 0) / students.length)
            : 0;

        // ── Recent alerts (top 5 high-risk students) ──────────────────
        const recentAlerts = students
            .filter(s => s.riskLevel === 'high' || s.riskLevel === 'medium')
            .slice(0, 5)
            .map(s => {
                // Build alert message
                let message = '';
                let subText = '';

                if (s.keyFactors.includes('No Quiz Attempts')) {
                    message = `${s.name} has not attempted any quizzes yet.`;
                    subText = 'No Engagement';
                } else if (s.avgScore != null && s.avgScore < 50) {
                    message = `${s.name} scored ${s.avgScore}% in recent quiz.`;
                    subText = `High Risk Score`;
                } else if (s.keyFactors.includes('Missing Assignments')) {
                    message = `${s.name} has missing assignments.`;
                    subText = 'Low Submission Rate';
                } else if (s.weakTopics.length > 0) {
                    message = `${s.name} struggled in ${s.weakTopics.slice(0, 2).join(' & ')}.`;
                    subText = `${s.weakTopics.length} Weak Topics`;
                } else {
                    message = `${s.name} shows ${s.riskLevel} risk indicators.`;
                    subText = s.keyFactors[0] || 'Multiple Risk Factors';
                }

                return {
                    studentId: s.studentId,
                    name: s.name,
                    avatar: s.avatar,
                    riskLevel: s.riskLevel,
                    riskScore: s.riskScore,
                    message,
                    subText,
                    extraTag: s.keyFactors[1] || null,
                };
            });

        // ── AI Recommendations ────────────────────────────────────────
        let aiRecommendations = [];
        if (students.length > 0 && GROQ_API_KEY) {
            try {
                const topRisk = students.slice(0, 5).map(s =>
                    `- ${s.name}: risk ${s.riskScore}/100, factors: ${s.keyFactors.slice(0, 2).join(', ')}`
                ).join('\n');

                const prompt = `
You are an expert educational risk analyst. These students are at risk:
${topRisk}

Generate 6 short, actionable recommendations for the tutor.
Return ONLY valid JSON array (no markdown):
[
  { "action": "<short action title, max 6 words>", "detail": "<1 sentence specific detail>" }
]
`.trim();

                const raw = await callGroqAI(prompt);
                const s = raw.indexOf('['), e = raw.lastIndexOf(']') + 1;
                aiRecommendations = JSON.parse(raw.slice(s, e)).slice(0, 6);
            } catch { /* non-critical */ }
        }

        // ── Log ───────────────────────────────────────────────────────
        logAIUsage(req.user._id, 'analytics', {
            type: 'risk_predictor',
            total: students.length,
            highRisk: highCount,
        });

        res.status(200).json({
            success: true,
            students,
            riskSummary,
            recentAlerts,
            dropoutPrediction,
            heatmap,
            courseList: courses.map(c => ({ _id: c._id, title: c.title })),
            aiRecommendations,
        });

    } catch (error) {
        console.error('getRiskPrediction error:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch risk predictions' });
    }
};

const getTutorRiskActionContext = async (req, courseId = null) => {
    const Tutor = (await import('../models/Tutor.js')).default;
    const Course = (await import('../models/Course.js')).default;
    const Enrollment = (await import('../models/Enrollment.js')).default;

    const tutor = await Tutor.findOne({ userId: req.user._id }).select('_id instituteId').lean();
    if (!tutor) {
        const error = new Error('Tutor profile not found');
        error.statusCode = 403;
        throw error;
    }

    const courseFilter = { tutorId: tutor._id };
    if (courseId) courseFilter._id = courseId;
    const courses = await Course.find(courseFilter).select('_id title instituteId').lean();
    const courseIds = courses.map(course => course._id);

    const enrollments = await Enrollment.find({ courseId: { $in: courseIds }, status: 'active' })
        .populate('studentId', 'name email profileImage parentDetails notificationSettings')
        .lean();

    const seen = new Set();
    const students = [];
    for (const enrollment of enrollments) {
        const student = enrollment.studentId;
        if (!student?._id) continue;
        const studentKey = student._id.toString();
        if (seen.has(studentKey)) continue;
        seen.add(studentKey);

        const risk = await computeStudentRisk(student._id, courseIds);
        const level = risk.riskLevel.toLowerCase();
        const primaryCourse = courses.find(course => course._id.toString() === enrollment.courseId?.toString());
        students.push({
            _id: student._id,
            name: student.name || 'Student',
            email: student.email || '',
            avatar: student.profileImage || null,
            parentDetails: student.parentDetails || [],
            courseId: enrollment.courseId,
            courseName: primaryCourse?.title || 'Course',
            riskLevel: level,
            riskLabel: risk.riskLevel,
            riskScore: risk.score,
            avgProgress: Math.round(risk.avgProgress),
            avgQuizScore: Math.round(risk.avgQuizScore),
            avgGrade: Math.round(risk.avgGrade),
            failedQuizzes: risk.failedQuizzes,
            missedSubs: risk.missedSubs,
            causes: risk.causes,
        });
    }

    students.sort((a, b) => b.riskScore - a.riskScore);

    return { tutor, courses, courseIds, students };
};

const getActionTargets = (students, action) => {
    if (action === 'notify') return students.filter(student => student.riskLevel !== 'low');
    if (action === 'assign_study_plans') return students.filter(student => student.riskLevel !== 'low');
    if (action === 'schedule_remedial') return students.filter(student => student.riskLevel !== 'low');
    if (action === 'progress_report') return students;
    if (action === 'analyze') return students;
    return students.filter(student => student.riskLevel === 'high');
};

const getStudentWeakTopicsForAction = (student) => {
    const fromCauses = (student.causes || []).map(cause => {
        if (cause === 'Weak Grades') return 'Score improvement practice';
        if (cause === 'Poor Attendance') return 'Consistency and backlog recovery';
        if (cause === 'Weak Topics') return 'Weak topic revision';
        if (cause === 'Demotivation') return 'Daily accountability routine';
        return cause;
    });
    return [...new Set(fromCauses.length ? fromCauses : ['Core concepts revision', 'Practice questions'])].slice(0, 5);
};

// @desc    Execute real risk-predictor quick actions
// @route   POST /api/ai/risk-predictor/action
// @access  Private (tutor)
export const performRiskPredictorAction = async (req, res) => {
    try {
        const { action, courseId } = req.body || {};
        if (!action) {
            return res.status(400).json({ success: false, message: 'action is required' });
        }

        const allowedActions = new Set([
            'alert_parents',
            'schedule_remedial',
            'progress_report',
            'assign_study_plans',
            'high_risk_action_plans',
            'identified_action_plans',
            'share',
            'notify',
            'analyze',
        ]);
        if (!allowedActions.has(action)) {
            return res.status(400).json({ success: false, message: 'Unsupported action' });
        }

        const { tutor, students } = await getTutorRiskActionContext(req, courseId);
        const targets = getActionTargets(students, action);
        const { createNotification } = await import('./notificationController.js');

        if (targets.length === 0 && action !== 'share' && action !== 'analyze') {
            return res.status(200).json({
                success: true,
                message: 'No eligible at-risk students found for this action.',
                result: { affected: 0, action },
            });
        }

        if (action === 'alert_parents') {
            const { sendEmail } = await import('../utils/emailService.js');
            let parentEmails = 0;
            let studentNotifications = 0;

            for (const student of targets) {
                const subject = `Academic risk alert for ${student.name}`;
                const html = `
                    <div style="font-family:Arial,sans-serif;line-height:1.6;color:#0f172a">
                        <h2>Academic Support Alert</h2>
                        <p>${student.name} is currently marked as <strong>${student.riskLabel} Risk</strong> in ${student.courseName}.</p>
                        <p><strong>Risk score:</strong> ${student.riskScore}/100</p>
                        <p><strong>Main indicators:</strong> ${(student.causes || []).join(', ') || 'Academic engagement needs review'}</p>
                        <p>Please connect with the tutor/admin team for a remedial support plan.</p>
                    </div>
                `;
                for (const parent of student.parentDetails || []) {
                    if (parent.email) {
                        const sent = await sendEmail({ email: parent.email, subject, html });
                        if (sent) parentEmails += 1;
                    }
                }
                const notification = await createNotification({
                    userId: student._id,
                    type: 'reminder',
                    title: 'Academic support alert',
                    message: `Your tutor has flagged ${student.courseName} for extra support. Please review your remedial plan.`,
                    data: { courseId: student.courseId, extras: { action, riskScore: student.riskScore, tutorId: String(tutor._id) } },
                });
                if (notification) studentNotifications += 1;
            }

            return res.status(200).json({
                success: true,
                message: `Parent alerts processed for ${targets.length} high-risk student(s).`,
                result: { affected: targets.length, parentEmails, studentNotifications },
            });
        }

        if (action === 'schedule_remedial') {
            const Appointment = (await import('../models/Appointment.js')).default;
            const start = new Date();
            start.setDate(start.getDate() + 1);
            start.setHours(16, 0, 0, 0);

            let created = 0;
            for (const [index, student] of targets.entries()) {
                const dateTime = new Date(start.getTime() + index * 60 * 60 * 1000);
                await Appointment.create({
                    studentId: student._id,
                    tutorId: tutor._id,
                    dateTime,
                    duration: 45,
                    status: 'confirmed',
                    amount: 0,
                    notes: `AI risk predictor remedial session. Focus: ${getStudentWeakTopicsForAction(student).join(', ')}`,
                    sessionType: 'online_live',
                });
                created += 1;
                await createNotification({
                    userId: student._id,
                    type: 'reminder',
                    title: 'Remedial session scheduled',
                    message: `A remedial session has been scheduled for ${student.courseName}.`,
                    data: { courseId: student.courseId, extras: { action, dateTime, tutorId: String(tutor._id) } },
                });
            }

            return res.status(200).json({
                success: true,
                message: `${created} remedial session(s) scheduled and students notified.`,
                result: { affected: targets.length, appointmentsCreated: created },
            });
        }

        if (action === 'assign_study_plans' || action === 'high_risk_action_plans' || action === 'identified_action_plans') {
            const StudyPlan = (await import('../models/StudyPlan.js')).default;
            let created = 0;

            for (const student of targets) {
                const weakTopics = getStudentWeakTopicsForAction(student);
                const fallback = buildFallbackStudyPlan({
                    studentName: student.name,
                    weakTopics,
                    durationWeeks: student.riskLevel === 'high' ? 3 : 2,
                    hoursPerDay: student.riskLevel === 'high' ? 2 : 1,
                    difficulty: student.riskLevel === 'high' ? 'intensive' : 'moderate',
                });
                const totalStudyMins = fallback.weeklyPlan.reduce((sum, day) => sum + (day.totalMinutes || 0), 0);
                const plan = await StudyPlan.create({
                    tutorId: tutor._id,
                    studentId: student._id,
                    courseId: student.courseId || null,
                    instituteId: req.user.instituteId || null,
                    title: action === 'assign_study_plans' ? fallback.title : `${student.riskLabel} Risk Action Plan`,
                    studentName: student.name,
                    weakTopics,
                    durationWeeks: student.riskLevel === 'high' ? 3 : 2,
                    hoursPerDay: student.riskLevel === 'high' ? 2 : 1,
                    difficulty: student.riskLevel === 'high' ? 'intensive' : 'moderate',
                    goal: fallback.goal,
                    summary: fallback.summary,
                    keyMilestones: fallback.keyMilestones,
                    estimatedScore: fallback.estimatedScore,
                    weeklyPlan: fallback.weeklyPlan,
                    totalDays: fallback.weeklyPlan.length,
                    totalStudyHours: Math.round(totalStudyMins / 60 * 10) / 10,
                    topicsCount: fallback.weeklyPlan.reduce((sum, day) => sum + (day.topics?.length || 0), 0),
                    status: 'active',
                });
                created += 1;
                await createNotification({
                    userId: student._id,
                    type: 'study_plan_generated',
                    title: 'New corrective study plan',
                    message: `Your tutor assigned a ${student.riskLabel.toLowerCase()} risk recovery plan.`,
                    data: { courseId: student.courseId, extras: { planId: plan._id, action, tutorId: String(tutor._id) } },
                });
            }

            return res.status(200).json({
                success: true,
                message: `${created} corrective study/action plan(s) assigned to students.`,
                result: { affected: targets.length, plansCreated: created },
            });
        }

        if (action === 'progress_report') {
            const GeneratedReport = (await import('../models/GeneratedReport.js')).default;
            const report = await GeneratedReport.create({
                tutorId: tutor._id,
                instituteId: req.user.instituteId || null,
                reportType: 'student',
                title: `Risk Predictor Progress Report - ${new Date().toLocaleDateString('en-IN')}`,
                description: 'Generated from live risk, progress, quiz, and submission metrics.',
                studentIds: targets.map(student => student._id),
                studentNames: targets.map(student => student.name),
                quickSelection: 'risk_predictor',
                summary: `${targets.length} student(s) included. ${targets.filter(s => s.riskLevel === 'high').length} high-risk student(s) require immediate intervention.`,
                students: targets.map(student => ({
                    studentId: student._id,
                    name: student.name,
                    avatar: student.avatar,
                    avgScore: student.avgQuizScore,
                    progress: student.avgProgress,
                    grade: `${student.riskScore}/100 risk`,
                    strengths: student.riskLevel === 'low' ? ['On track'] : [],
                    weaknesses: student.causes,
                    skillBreakdown: getStudentWeakTopicsForAction(student).map((topic, index) => ({
                        topic,
                        score: Math.max(20, 80 - index * 10),
                        color: index === 0 ? '#EF4444' : '#F59E0B',
                    })),
                    recommendation: student.riskLevel === 'high'
                        ? 'Schedule a remedial session and assign a corrective study plan.'
                        : 'Monitor progress weekly and reinforce weak areas.',
                })),
                status: 'ready',
            });

            return res.status(200).json({
                success: true,
                message: `Academic progress report generated for ${targets.length} student(s).`,
                result: { affected: targets.length, reportId: report._id },
            });
        }

        if (action === 'notify') {
            let sent = 0;
            for (const student of targets) {
                const notification = await createNotification({
                    userId: student._id,
                    type: 'reminder',
                    title: 'Tutor check-in requested',
                    message: `Please review your progress in ${student.courseName}. Your tutor may assign corrective tasks.`,
                    data: { courseId: student.courseId, extras: { action, riskScore: student.riskScore, tutorId: String(tutor._id) } },
                });
                if (notification) sent += 1;
            }
            return res.status(200).json({
                success: true,
                message: `${sent} student notification(s) sent.`,
                result: { affected: targets.length, notificationsSent: sent },
            });
        }

        if (action === 'share') {
            const shareUrl = `${process.env.FRONTEND_URL || ''}/tutor/ai-buddy/risk-predictor${courseId ? `?courseId=${courseId}` : ''}`;
            return res.status(200).json({
                success: true,
                message: 'Risk dashboard share link generated.',
                result: { affected: 0, shareUrl },
            });
        }

        const high = students.filter(student => student.riskLevel === 'high').length;
        const medium = students.filter(student => student.riskLevel === 'medium').length;
        const avgRisk = students.length
            ? Math.round(students.reduce((sum, student) => sum + student.riskScore, 0) / students.length)
            : 0;

        return res.status(200).json({
            success: true,
            message: 'Detailed risk analysis completed.',
            result: {
                affected: students.length,
                highRisk: high,
                mediumRisk: medium,
                averageRiskScore: avgRisk,
                topCauses: [...new Set(students.flatMap(student => student.causes || []))].slice(0, 5),
            },
        });
    } catch (error) {
        console.error('performRiskPredictorAction error:', error);
        res.status(error.statusCode || 500).json({
            success: false,
            message: error.message || 'Failed to execute risk action',
        });
    }
};

// ── Helper: compute risk score for one student ────────────────────────────────
async function computeStudentRisk(studentId, courseIds) {
    const [enrollment, quizAttempts, submissions] = await Promise.all([
        (async () => {
            const Enrollment = (await import('../models/Enrollment.js')).default;
            return Enrollment.find({ studentId, courseId: { $in: courseIds } }).lean();
        })(),
        QuizAttempt.find({ studentId }).sort({ createdAt: -1 }).limit(20).lean(),
        (async () => {
            const Submission = (await import('../models/Submission.js')).default;
            return Submission.find({ studentId }).lean();
        })(),
    ]);

    // ── Signals ───────────────────────────────────────────────────
    const avgProgress = enrollment.length
        ? enrollment.reduce((s, e) => s + (e.progress?.percentage || 0), 0) / enrollment.length
        : 0;

    const avgQuizScore = quizAttempts.length
        ? quizAttempts.reduce((s, q) => s + (q.score || 0), 0) / quizAttempts.length
        : 100;

    const failedQuizzes = quizAttempts.filter(q => q.score < 50).length;
    const gradedSubs = submissions.filter(s => s.status === 'graded');
    const avgGrade = gradedSubs.length
        ? gradedSubs.reduce((s, sub) => s + ((sub.grade / (sub.totalMarks || 100)) * 100), 0) / gradedSubs.length
        : 100;
    const missedSubs = submissions.filter(s => s.status === 'submitted' && !s.grade).length;

    // ── Risk score (0–100, higher = more at risk) ─────────────────
    let score = 0;
    if (avgProgress < 20) score += 30;
    else if (avgProgress < 50) score += 15;

    if (avgQuizScore < 40) score += 30;
    else if (avgQuizScore < 60) score += 15;

    if (failedQuizzes >= 3) score += 20;
    else if (failedQuizzes >= 1) score += 10;

    if (avgGrade < 40) score += 20;
    else if (avgGrade < 60) score += 10;

    score = Math.min(100, score);

    const riskLevel = score >= 60 ? 'High' : score >= 35 ? 'Medium' : 'Low';

    // ── Causes ────────────────────────────────────────────────────
    const causes = [];
    if (avgQuizScore < 60) causes.push('Weak Grades');
    if (avgProgress < 40) causes.push('Poor Attendance');
    if (failedQuizzes >= 2) causes.push('Weak Topics');
    if (missedSubs >= 2) causes.push('Demotivation');

    return { score, riskLevel, avgProgress, avgQuizScore, avgGrade, failedQuizzes, missedSubs, causes };
}

// @desc    Get dropout risk analysis for all students in tutor's courses
// @route   GET /api/ai/dropout-risk
// @access  Private (tutor)
export const getDropoutRiskAnalysis = async (req, res) => {
    try {
        const Tutor = (await import('../models/Tutor.js')).default;
        const Course = (await import('../models/Course.js')).default;
        const Enrollment = (await import('../models/Enrollment.js')).default;
        const User = (await import('../models/User.js')).default;

        const tutor = await Tutor.findOne({ userId: req.user._id }).select('_id').lean();
        if (!tutor) return res.status(403).json({ success: false, message: 'Tutor profile not found' });

        // Tutor's courses
        const courses = await Course.find({ tutorId: tutor._id, status: 'published' }).select('_id title').lean();
        const courseIds = courses.map(c => c._id);

        if (courseIds.length === 0) {
            return res.status(200).json({ success: true, students: [], overview: { high: 0, medium: 0, low: 0 }, causesBreakdown: [], alerts: [], actionPlans: [] });
        }

        // All enrolled students
        const enrollments = await Enrollment.find({ courseId: { $in: courseIds }, status: 'active' })
            .populate('studentId', 'name email avatar')
            .lean();

        // Unique students
        const studentMap = {};
        enrollments.forEach(e => {
            if (e.studentId?._id) {
                studentMap[e.studentId._id.toString()] = e.studentId;
            }
        });
        const students = Object.values(studentMap);

        // Compute risk for each student (limit to 50 for performance)
        const results = await Promise.all(
            students.slice(0, 50).map(async (student) => {
                const risk = await computeStudentRisk(student._id, courseIds);
                return {
                    _id: student._id,
                    name: student.name || 'Student',
                    email: student.email || '',
                    avatar: student.avatar || null,
                    riskLevel: risk.riskLevel,
                    riskScore: risk.score,
                    avgProgress: Math.round(risk.avgProgress),
                    avgQuizScore: Math.round(risk.avgQuizScore),
                    avgGrade: Math.round(risk.avgGrade),
                    failedQuizzes: risk.failedQuizzes,
                    missedSubs: risk.missedSubs,
                    causes: risk.causes,
                };
            })
        );

        // Sort by risk score descending
        results.sort((a, b) => b.riskScore - a.riskScore);

        // ── Overview counts ───────────────────────────────────────
        const high = results.filter(s => s.riskLevel === 'High').length;
        const medium = results.filter(s => s.riskLevel === 'Medium').length;
        const low = results.filter(s => s.riskLevel === 'Low').length;
        const total = results.length;

        // ── Causes breakdown (aggregate across all students) ──────
        const causeCount = {};
        results.forEach(s => s.causes.forEach(c => { causeCount[c] = (causeCount[c] || 0) + 1; }));
        const totalCauses = Object.values(causeCount).reduce((a, b) => a + b, 0) || 1;
        const causesBreakdown = Object.entries(causeCount)
            .map(([cause, count]) => ({ cause, count, pct: Math.round((count / totalCauses) * 100) }))
            .sort((a, b) => b.count - a.count);

        // ── Latest alerts (top 5 high-risk students) ──────────────
        const alerts = results.filter(s => s.riskLevel !== 'Low').slice(0, 5).map(s => {
            const mainCause = s.causes[0] || 'Low Engagement';
            const detail = mainCause === 'Weak Grades'
                ? `scored ${s.avgQuizScore}% in recent quizzes`
                : mainCause === 'Poor Attendance'
                    ? `progress only ${s.avgProgress}% complete`
                    : mainCause === 'Weak Topics'
                        ? `failed ${s.failedQuizzes} quizzes`
                        : `missed ${s.missedSubs} submissions`;
            return {
                studentId: s._id,
                name: s.name,
                avatar: s.avatar,
                riskLevel: s.riskLevel,
                mainCause,
                detail,
                timeAgo: 'Recently',
            };
        });

        // ── AI-generated action plans ─────────────────────────────
        const highRiskNames = results.filter(s => s.riskLevel === 'High').slice(0, 3).map(s => s.name);
        let actionPlans = [
            { action: 'Alert Parents of all At-Risk Students', priority: 'high', count: high + medium },
            { action: 'Schedule Remedial Classes for Weak Grades & Topics', priority: 'high', count: high },
            { action: 'Assign Study Plans to Improve Grades', priority: 'medium', count: medium },
            { action: 'Offer Counseling Sessions for Demotivated Students', priority: 'low', count: low },
        ];

        // ── Weekly trend (mock based on real data — last 3 weeks) ─
        // In production, store weekly snapshots; here we approximate
        const trend = [
            { week: '1week ago', total: Math.max(0, total - 5), high: Math.max(0, high - 2), medium: Math.max(0, medium - 1) },
            { week: '2weeks ago', total: Math.max(0, total - 2), high: Math.max(0, high - 1), medium },
            { week: 'This week', total, high, medium },
        ];

        // Log usage
        logAIUsage(req.user._id, 'analytics', { type: 'dropout_risk', studentCount: total });

        res.status(200).json({
            success: true,
            overview: {
                high, medium, low, total,
                highPct: total ? Math.round((high / total) * 100) : 0,
                mediumPct: total ? Math.round((medium / total) * 100) : 0,
                lowPct: total ? Math.round((low / total) * 100) : 0,
            },
            students: results,
            causesBreakdown,
            alerts,
            actionPlans,
            trend,
            courses: courses.map(c => ({ _id: c._id, title: c.title })),
        });

    } catch (error) {
        console.error('getDropoutRiskAnalysis error:', error);
        res.status(500).json({ success: false, message: 'Failed to analyze dropout risk' });
    }
};

// @desc    Get dropout risk for a single student
// @route   GET /api/ai/dropout-risk/student/:studentId
// @access  Private (tutor)
export const getStudentDropoutRisk = async (req, res) => {
    try {
        const Tutor = (await import('../models/Tutor.js')).default;
        const Course = (await import('../models/Course.js')).default;
        const User = (await import('../models/User.js')).default;

        const tutor = await Tutor.findOne({ userId: req.user._id }).select('_id').lean();
        if (!tutor) return res.status(403).json({ success: false, message: 'Tutor profile not found' });

        const courses = await Course.find({ tutorId: tutor._id }).select('_id title').lean();
        const courseIds = courses.map(c => c._id);

        const student = await User.findById(req.params.studentId).select('name email avatar').lean();
        if (!student) return res.status(404).json({ success: false, message: 'Student not found' });

        const risk = await computeStudentRisk(student._id, courseIds);

        // AI-generated personalized recommendation
        let recommendation = '';
        try {
            const prompt = `
A student named "${student.name}" has the following academic profile:
- Average quiz score: ${Math.round(risk.avgQuizScore)}%
- Course progress: ${Math.round(risk.avgProgress)}%
- Failed quizzes: ${risk.failedQuizzes}
- Missing submissions: ${risk.missedSubs}
- Risk level: ${risk.riskLevel}
- Main causes: ${risk.causes.join(', ') || 'None identified'}

Write a 2-3 sentence personalized recommendation for the tutor on how to help this student avoid dropout. Be specific and actionable.
`.trim();
            recommendation = await callGroqAI(prompt);
        } catch { recommendation = 'Schedule a one-on-one session to identify barriers and create a personalized improvement plan.'; }

        res.status(200).json({
            success: true,
            student: {
                _id: student._id,
                name: student.name,
                email: student.email,
                avatar: student.avatar,
            },
            risk: {
                ...risk,
                riskScore: risk.score,
                avgProgress: Math.round(risk.avgProgress),
                avgQuizScore: Math.round(risk.avgQuizScore),
                avgGrade: Math.round(risk.avgGrade),
            },
            recommendation,
        });
    } catch (error) {
        console.error('getStudentDropoutRisk error:', error);
        res.status(500).json({ success: false, message: 'Failed to get student risk' });
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// ═══  STUDENT-FACING AI ENDPOINTS  ═════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════════

// @desc    Get simplified notes shared TO student's enrolled courses
// @route   GET /api/ai/student/shared-notes
// @access  Private (student)
export const getStudentSharedNotes = async (req, res) => {
    try {
        const { page = 1, limit = 10, courseId } = req.query;
        const Enrollment = (await import('../models/Enrollment.js')).default;

        // Get student's enrolled course IDs
        const enrollments = await Enrollment.find({ studentId: req.user._id, status: 'active' }).select('courseId').lean();
        const enrolledCourseIds = enrollments.map(e => e.courseId);

        if (enrolledCourseIds.length === 0) {
            return res.status(200).json({ success: true, total: 0, notes: [] });
        }

        // Find notes shared to these courses
        const filter = { 'sharedToCourses.courseId': { $in: enrolledCourseIds } };
        if (courseId) filter['sharedToCourses.courseId'] = courseId;

        const skip = (Number(page) - 1) * Number(limit);
        const total = await SimplifiedNote.countDocuments(filter);

        const notes = await SimplifiedNote.find(filter)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(Number(limit))
            .populate('courseId', 'title')
            .populate('userId', 'name profileImage')
            .select('title gradeLevel originalWordCount simplifiedWordCount wordsReduced infoRetained simplifiedText courseId userId sharedToCourses createdAt')
            .lean();

        const formatted = notes.map(n => {
            const diffMs = Date.now() - new Date(n.createdAt).getTime();
            const diffMin = Math.floor(diffMs / 60000);
            const timeAgo = diffMin < 1 ? 'Just now'
                : diffMin < 60 ? `${diffMin}m ago`
                    : diffMin < 1440 ? `${Math.floor(diffMin / 60)}h ago`
                        : diffMin < 10080 ? `${Math.floor(diffMin / 1440)}d ago`
                            : new Date(n.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });

            return {
                _id: n._id,
                title: n.title,
                gradeLevel: n.gradeLevel,
                originalWordCount: n.originalWordCount,
                simplifiedWordCount: n.simplifiedWordCount,
                wordsReduced: n.wordsReduced,
                infoRetained: n.infoRetained,
                simplifiedText: n.simplifiedText,
                course: n.courseId?.title || null,
                courseId: n.courseId?._id || null,
                tutorName: n.userId?.name || 'Tutor',
                tutorAvatar: n.userId?.profileImage || null,
                timeAgo,
                createdAt: n.createdAt,
            };
        });

        res.status(200).json({ success: true, total, page: Number(page), pages: Math.ceil(total / Number(limit)), notes: formatted });
    } catch (error) {
        console.error('getStudentSharedNotes error:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch shared notes' });
    }
};

// @desc    Get lecture summaries for student's enrolled courses
// @route   GET /api/ai/student/lecture-summaries
// @access  Private (student)
export const getStudentLectureSummaries = async (req, res) => {
    try {
        const { page = 1, limit = 10, courseId } = req.query;
        const Enrollment = (await import('../models/Enrollment.js')).default;

        const enrollments = await Enrollment.find({ studentId: req.user._id, status: 'active' }).select('courseId').lean();
        const enrolledCourseIds = enrollments.map(e => e.courseId);

        if (enrolledCourseIds.length === 0) {
            return res.status(200).json({ success: true, total: 0, records: [] });
        }

        const filter = { courseId: { $in: enrolledCourseIds }, status: 'ready' };
        if (courseId) filter.courseId = courseId;

        const skip = (Number(page) - 1) * Number(limit);
        const total = await LectureSummary.countDocuments(filter);

        const records = await LectureSummary.find(filter)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(Number(limit))
            .populate('courseId', 'title')
            .populate('lessonId', 'title type')
            .populate('userId', 'name profileImage')
            .select('title sourceType keyPoints insights wordCount readTime courseId lessonId userId createdAt')
            .lean();

        const formatted = records.map(r => {
            const diffMs = Date.now() - new Date(r.createdAt).getTime();
            const diffMin = Math.floor(diffMs / 60000);
            const timeAgo = diffMin < 1 ? 'Just now'
                : diffMin < 60 ? `${diffMin}m ago`
                    : diffMin < 1440 ? `${Math.floor(diffMin / 60)}h ago`
                        : diffMin < 10080 ? `${Math.floor(diffMin / 1440)}d ago`
                            : new Date(r.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });

            return {
                ...r,
                timeAgo,
                course: r.courseId?.title || null,
                lesson: r.lessonId?.title || null,
                tutorName: r.userId?.name || 'Tutor',
                tutorAvatar: r.userId?.profileImage || null,
            };
        });

        res.status(200).json({ success: true, total, page: Number(page), pages: Math.ceil(total / Number(limit)), records: formatted });
    } catch (error) {
        console.error('getStudentLectureSummaries error:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch lecture summaries' });
    }
};

// @desc    Get a single lecture summary — student access (enrolled course check)
// @route   GET /api/ai/student/lecture-summaries/:id
// @access  Private (student)
export const getStudentLectureSummaryById = async (req, res) => {
    try {
        const Enrollment = (await import('../models/Enrollment.js')).default;

        const record = await LectureSummary.findById(req.params.id)
            .populate('courseId', 'title')
            .populate('lessonId', 'title type')
            .populate('userId', 'name profileImage')
            .lean();

        if (!record) return res.status(404).json({ success: false, message: 'Summary not found' });

        // Verify student is enrolled in the course
        const isEnrolled = await Enrollment.findOne({ studentId: req.user._id, courseId: record.courseId?._id, status: 'active' });
        if (!isEnrolled) return res.status(403).json({ success: false, message: 'Access denied' });

        res.status(200).json({ success: true, record });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to fetch summary' });
    }
};

// @desc    Get study plans created FOR this student
// @route   GET /api/ai/student/study-plans
// @access  Private (student)
export const getMyStudyPlans = async (req, res) => {
    try {
        const { page = 1, limit = 10 } = req.query;
        const StudyPlan = (await import('../models/StudyPlan.js')).default;

        const filter = { studentId: req.user._id };
        const skip = (Number(page) - 1) * Number(limit);
        const total = await StudyPlan.countDocuments(filter);

        const plans = await StudyPlan.find(filter)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(Number(limit))
            .populate('courseId', 'title')
            .populate('tutorId', 'userId')
            .lean();

        // Populate tutor user name
        const User = (await import('../models/User.js')).default;
        const formatted = await Promise.all(plans.map(async (p) => {
            let tutorName = 'Tutor';
            if (p.tutorId?.userId) {
                const tutorUser = await User.findById(p.tutorId.userId).select('name').lean();
                tutorName = tutorUser?.name || 'Tutor';
            }

            const diffMs = Date.now() - new Date(p.createdAt).getTime();
            const diffMin = Math.floor(diffMs / 60000);
            const timeAgo = diffMin < 1 ? 'Just now'
                : diffMin < 60 ? `${diffMin}m ago`
                    : diffMin < 1440 ? `${Math.floor(diffMin / 60)}h ago`
                        : diffMin < 10080 ? `${Math.floor(diffMin / 1440)}d ago`
                            : new Date(p.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });

            return {
                _id: p._id,
                title: p.title || `Study Plan - ${p.courseId?.title || 'General'}`,
                course: p.courseId?.title || null,
                status: p.status || 'active',
                durationWeeks: p.durationWeeks,
                weeklyHours: p.weeklyHours,
                focusAreas: p.focusAreas,
                weeklyPlan: p.weeklyPlan,
                strengths: p.strengths,
                weaknesses: p.weaknesses,
                tutorName,
                timeAgo,
                createdAt: p.createdAt,
            };
        }));

        res.status(200).json({ success: true, total, page: Number(page), pages: Math.ceil(total / Number(limit)), plans: formatted });
    } catch (error) {
        console.error('getMyStudyPlans error:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch study plans' });
    }
};

// @desc    Get student's own weak topics based on quiz attempt scores
// @route   GET /api/ai/student/weak-topics
// @access  Private (student)
export const getStudentWeakTopics = async (req, res) => {
    try {
        const Enrollment = (await import('../models/Enrollment.js')).default;

        // Get student's enrolled courses
        const enrollments = await Enrollment.find({ studentId: req.user._id, status: 'active' }).select('courseId').lean();
        const courseIds = enrollments.map(e => e.courseId);

        if (courseIds.length === 0) {
            return res.status(200).json({
                success: true,
                weakTopics: [],
                overallStats: { avgScore: 0, totalAttempts: 0, weakTopicCount: 0 },
                aiRecommendations: null,
            });
        }

        // Get lessons for enrolled courses
        const lessons = await Lesson.find({ courseId: { $in: courseIds } }).select('_id title courseId').lean();
        const lessonIds = lessons.map(l => l._id);
        const lessonMap = lessons.reduce((m, l) => { m[l._id.toString()] = l; return m; }, {});

        // Get course titles
        const Course = (await import('../models/Course.js')).default;
        const courses = await Course.find({ _id: { $in: courseIds } }).select('_id title').lean();
        const courseMap = courses.reduce((m, c) => { m[c._id.toString()] = c; return m; }, {});

        // Aggregate student's quiz attempts per lesson
        const quizAgg = await QuizAttempt.aggregate([
            { $match: { studentId: req.user._id, lessonId: { $in: lessonIds } } },
            {
                $group: {
                    _id: '$lessonId',
                    avgScore: { $avg: '$score' },
                    totalAttempts: { $sum: 1 },
                    passedCount: { $sum: { $cond: ['$isPassed', 1, 0] } },
                    failedCount: { $sum: { $cond: ['$isPassed', 0, 1] } },
                    minScore: { $min: '$score' },
                    maxScore: { $max: '$score' },
                    lastAttempt: { $max: '$createdAt' },
                },
            },
            { $sort: { avgScore: 1 } },
        ]);

        const weakTopics = quizAgg
            .filter(q => q.avgScore < 75)
            .map(q => {
                const lesson = lessonMap[q._id.toString()];
                const cId = lesson?.courseId?.toString();
                const course = courseMap[cId];
                const avgScore = Math.round(q.avgScore);
                const severity = avgScore < 40 ? 'critical' : avgScore < 60 ? 'warning' : 'moderate';

                return {
                    lessonId: q._id,
                    lessonTitle: lesson?.title || 'Unknown',
                    courseId: cId,
                    courseTitle: course?.title || 'Unknown',
                    avgScore,
                    totalAttempts: q.totalAttempts,
                    passedCount: q.passedCount,
                    failedCount: q.failedCount,
                    minScore: Math.round(q.minScore),
                    maxScore: Math.round(q.maxScore),
                    severity,
                    lastAttempt: q.lastAttempt,
                };
            });

        // Overall stats
        const allScores = quizAgg.map(q => q.avgScore);
        const avgScore = allScores.length > 0 ? Math.round(allScores.reduce((s, x) => s + x, 0) / allScores.length) : 0;
        const totalAttempts = quizAgg.reduce((s, q) => s + q.totalAttempts, 0);

        // AI recommendations
        let aiRecommendations = null;
        if (weakTopics.length > 0 && GROQ_API_KEY) {
            try {
                const topList = weakTopics.slice(0, 5).map(t =>
                    `- "${t.lessonTitle}" (${t.courseTitle}): avg ${t.avgScore}%, ${t.totalAttempts} attempts`
                ).join('\n');

                const prompt = `
You are a student learning advisor. This student is weak in:
${topList}

Return ONLY valid JSON (no markdown):
{
  "summary": "<2 sentence overview of the student's pattern>",
  "recommendations": [
    { "topic": "<lesson title>", "action": "<1 sentence specific study advice>" }
  ],
  "studyTips": ["<tip 1>", "<tip 2>", "<tip 3>"],
  "estimatedImprovementDays": <number>
}
`.trim();

                const raw = await callGroqAI(prompt);
                const s = raw.indexOf('{'), e = raw.lastIndexOf('}') + 1;
                aiRecommendations = JSON.parse(raw.slice(s, e));
            } catch { /* non-critical */ }
        }

        res.status(200).json({
            success: true,
            weakTopics,
            overallStats: { avgScore, totalAttempts, weakTopicCount: weakTopics.length },
            aiRecommendations,
        });

    } catch (error) {
        console.error('getStudentWeakTopics error:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch weak topics' });
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// ═══  AI PROCTORING ALERTS & EXAM REVIEW  ═══════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════════

// @desc    Get detailed timeline and AI risk analysis for a specific suspicious exam attempt
// @route   GET /api/ai/proctoring/review/:attemptId
// @access  Private (tutor)
export const getExamSuspicionReview = async (req, res) => {
    try {
        const { attemptId } = req.params;
        const Tutor = (await import('../models/Tutor.js')).default;
        const { ExamAttempt } = await import('../models/Exam.js');

        const tutor = await Tutor.findOne({ userId: req.user._id }).select('_id').lean();
        if (!tutor) return res.status(403).json({ success: false, message: 'Tutor profile not found' });

        const attempt = await ExamAttempt.findById(attemptId)
            .populate('examId', 'title totalQuestions duration') // Make sure duration is populated
            .populate('studentId', 'name avatar')
            .lean();

        if (!attempt) return res.status(404).json({ success: false, message: 'Attempt not found' });

        // Formatting data for the Review UI
        const timeline = [];

        // Add proctoring events to timeline
        (attempt.proctoringEvents || []).forEach(ev => {
            timeline.push({
                time: ev.timestamp,
                type: ev.eventType,
                severity: ev.severity,
                details: ev.details || 'Suspicious visual/audio activity recorded',
                videoTimestamp: ev.videoTimestamp
            });
        });

        // Add tab switches to timeline
        (attempt.tabSwitchLog || []).forEach(ts => {
            timeline.push({
                time: ts.switchedAt,
                type: 'tab_switch',
                severity: ts.count > 3 ? 'high' : 'medium',
                details: `Browser tab focus lost (x${ts.count})`,
                videoTimestamp: null
            });
        });

        // Sort timeline chronologically (Latest first for the log view)
        timeline.sort((a, b) => new Date(b.time) - new Date(a.time));

        let calculatedRisk = attempt.aiRiskLevel || 'Safe';
        if (calculatedRisk === 'Safe' && attempt.tabSwitchCount > 3) calculatedRisk = 'Suspicious Detected';
        if (calculatedRisk === 'Safe' && attempt.tabSwitchCount > 8) calculatedRisk = 'Cheating Detected';

        // 🔥 FIX: Extract all unique AI issues dynamically based on exact details
        const keyIssuesSet = new Set();

        if (attempt.tabSwitchCount > 0) {
            keyIssuesSet.add(`Frequent screen switching (${attempt.tabSwitchCount} times)`);
        }

        (attempt.proctoringEvents || []).forEach(e => {
            if (e.eventType === 'multiple_faces') {
                keyIssuesSet.add('Multiple people detected in frame');
            } else if (e.eventType === 'no_face') {
                keyIssuesSet.add('Student frequently left the camera frame');
            } else if (e.eventType === 'audio_anomaly') {
                // 🔥 NAYA: Speech-to-Text aur Noise ko alag-alag identify karna
                if (e.details && e.details.includes('Speech detected')) {
                    keyIssuesSet.add('Exact voice/talking captured during exam');
                } else if (e.details && e.details.includes('noise')) {
                    keyIssuesSet.add('Suspicious background noise detected');
                } else {
                    keyIssuesSet.add('Suspicious head movement or looking away continuously');
                }
            } else if (e.eventType === 'unauthorized_object') {
                if (e.details && e.details.includes('down')) {
                    keyIssuesSet.add('Student looking down continuously (Suspected phone/book usage)');
                } else {
                    keyIssuesSet.add('Unauthorized objects in frame');
                }
            }
        });

        const keyIssues = Array.from(keyIssuesSet);

        // 🔥 FIX: Convert timeSpent from seconds to minutes for the UI
        const timeSpentInMinutes = Math.round((attempt.timeSpent || 0) / 60);

        const reviewData = {
            _id: attempt._id,
            student: attempt.studentId ? attempt.studentId.name : 'Unknown Student',
            avatar: attempt.studentId?.avatar,
            examName: attempt.examId ? attempt.examId.title : 'Deleted Exam',
            examScore: attempt.score || 0,
            questionsAnswered: attempt.answers?.length || 0,
            totalQuestions: attempt.examId?.totalQuestions || 0,
            riskScore: attempt.aiRiskScore || (attempt.tabSwitchCount / 2),
            riskLevel: calculatedRisk,
            timeSpent: timeSpentInMinutes,
            violationsCount: timeline.length,
            timeline: timeline,
            keyIssues: keyIssues,
            aiProctoringSummary: attempt.aiProctoringSummary || null,
            videoUrl: 'https://www.w3schools.com/html/mov_bbb.mp4', // Mock video URL
        };

        res.status(200).json({
            success: true,
            reviewData
        });

    } catch (error) {
        console.error('getExamSuspicionReview error:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch suspicion review details' });
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// ═══  SMART ASSESSMENT: SUBJECTIVE CHECKER  ════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════════

// @desc    Evaluate student's subjective answer using AI
// @route   POST /api/ai/evaluate-subjective
// @access  Private (tutor)
export const evaluateSubjectiveAnswer = async (question, idealAnswer, studentAnswer, maxPoints = 1) => {
    try {
        if (!question || !studentAnswer) {
            return { isCorrect: false, pointsEarned: 0, feedback: 'Question and student answer are required', highlights: [] };
        }

        const prompt = `You are an expert academic evaluator. Your task is to evaluate a student's subjective answer against the provided question. 
Act objectively, critically, and supportively. Provide a detailed assessment mapping to Key Concepts, Clarity, Examples, and Depth of Knowledge.

Question: "${question}"
Ideal Answer: "${idealAnswer || 'None provided'}"
Student's Answer: "${studentAnswer}"

Provide a JSON object with EXACTLY this structure:
{
    "grade": "A+",
    "feedback": "String describing the strengths and areas of improvement.",
    "metrics": {
        "keyConcepts": 95,
        "clarity": 88,
        "examples": 90,
        "depthOfKnowledge": 79
    },
    "metricsText": {
        "keyConcepts": "Core ideas were thoroughly discussed.",
        "clarity": "The explanation was easy to follow without jargon.",
        "examples": "Relevant examples were provided.",
        "depthOfKnowledge": "Demonstrated solid understanding."
    },
    "tags": ["Tag1", "Tag2"],
    "stats": {
        "informationRetained": 88,
        "difficulty": "Balanced",
        "gradeLevel": "10th Grade"
    },
    "tips": [
        "Ask for specific terms next time.",
        "Suggest more real-world examples."
    ],
    "highlights": [
        {
            "phrase": "exact substring from student's answer",
            "type": "grammar" || "spelling" || "key_term" || "poor_phrasing" || "factual_error",
            "comment": "Why this is highlighted, explanation, correction, or praise."
        }
    ],
    "isCorrect": true,
    "pointsEarned": <a number between 0 and ${maxPoints} based on quality>
}
Ensure that:
1. Every "phrase" in the "highlights" array is an EXACT, case-sensitive substring of the student's answer.
2. The type field MUST be one of: "grammar", "spelling", "key_term", "poor_phrasing", "factual_error".
3. The output is strictly valid JSON without markdown wrapping.`;

        const aiResponseText = await callOpenAI(prompt);
        let cleanedText = aiResponseText.replace(/```(?:json)?/gi, '').trim();
        const jsonStart = cleanedText.indexOf('{');
        const jsonEnd = cleanedText.lastIndexOf('}') + 1;
        if (jsonStart !== -1 && jsonEnd !== 0) {
            cleanedText = cleanedText.slice(jsonStart, jsonEnd);
        }
        
        const evaluation = JSON.parse(cleanedText);

        return {
            isCorrect: evaluation.isCorrect || false,
            pointsEarned: evaluation.pointsEarned || 0,
            feedback: evaluation.feedback || 'Evaluated successfully.',
            highlights: evaluation.highlights || [],
            data: evaluation
        };
    } catch (error) {
        console.error('Evaluate Subjective Answer error:', error);
        return { isCorrect: false, pointsEarned: 0, feedback: 'AI failed to evaluate the answer', highlights: [] };
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// ═══  SMART ASSESSMENT: PLAGIARISM INSIGHT  ════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════════
// ─────────────────────────────────────────────────────────────────────────────
// PLAGIARISM CHECK CONTROLLER
// Append to aiController.js
// ─────────────────────────────────────────────────────────────────────────────

// @desc    Check plagiarism of submitted text/file using AI
// @route   POST /api/ai/plagiarism-check
// @access  Private (tutor)
// Body (multipart/form-data OR json):
//   text?        – raw text
//   file?        – DOCX / PDF upload (field: "file")
//   studentName? – optional student name
//   subject?     – optional subject
//   assignmentTitle? – optional
export const checkPlagiarism = async (req, res) => {
    try {
        if (!GROQ_API_KEY) return res.status(500).json({ success: false, message: 'Groq API key not configured' });

        // ── 1. Get input text ─────────────────────────────────────────
        let rawText = '';
        let sourceFileName = null;

        if (req.file) {
            rawText = await extractTextFromBuffer(req.file.buffer, req.file.mimetype, req.file.originalname);
            sourceFileName = req.file.originalname;
        } else {
            rawText = (req.body.text || '').trim();
        }

        if (!rawText || rawText.length < 30) {
            return res.status(400).json({ success: false, message: 'Text content (minimum 30 characters) or file upload is required.' });
        }

        const {
            studentName = 'Student',
            subject = '',
            assignmentTitle = sourceFileName?.replace(/\.[^.]+$/, '') || 'Assignment',
        } = req.body;

        // Generate report ID
        const reportId = `PLG${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
        const scannedOn = new Date().toLocaleString('en-IN', {
            day: '2-digit', month: 'long', year: 'numeric',
            hour: '2-digit', minute: '2-digit', hour12: true,
        });

        // ── 2. AI Prompt ──────────────────────────────────────────────
        const prompt = `
You are an expert academic plagiarism detection AI. Analyze the following student submission for plagiarism.

Assignment Title: "${assignmentTitle}"
${subject ? `Subject: ${subject}` : ''}
Student Name: "${studentName}"

Submitted Text:
"""
${rawText.slice(0, 5000)}
"""

Perform a thorough plagiarism analysis. Return ONLY valid JSON (no markdown, no backticks):
{
  "plagiarismScore": <integer 0-100 — estimated % of plagiarized content>,
  "originalScore": <integer 0-100 — must equal 100 - plagiarismScore>,
  "paraphrasedScore": <integer 0-100 — portion that appears paraphrased>,
  "riskLevel": "<Low|Medium|High|Critical>",
  "grade": "<letter grade considering plagiarism: A+|A|B+|B|C|D|F>",
  "verdict": "<short verdict: e.g. 'Needs Revision', 'Acceptable', 'Rejected'>",
  "sourcesFound": <integer 4-12 — number of potential sources detected>,
  "sources": [
    {
      "name": "<realistic source name e.g. PhysicsGuide.com>",
      "url": "<realistic URL>",
      "matchPercent": <integer>,
      "type": "<Web|Document|Journal|Book>",
      "uploadedDate": "<optional date string>"
    }
  ],
  "sentences": [
    {
      "text": "<first 60 chars of a sentence from the submission>",
      "status": "<Matched|Partial|Original>",
      "matchPercent": <integer 0-100>,
      "source": "<source name if matched>"
    }
  ],
  "highlightedSegments": [
    {
      "text": "<exact phrase from submission that is plagiarized or paraphrased>",
      "type": "<exact|paraphrased|original>",
      "source": "<source name>"
    }
  ],
  "aiSuggestions": [
    {
      "type": "<Replace|Add|Remove|Rephrase>",
      "original": "<original phrase from text>",
      "suggestion": "<what to do or replacement text>",
      "reason": "<1 sentence why>"
    }
  ],
  "summary": "<2-3 sentence overall analysis summary>"
}

Rules:
- Generate exactly 4 sources in "sources" array, match percents should sum to ~plagiarismScore
- Generate exactly 5-6 sentences in "sentences" array
- Generate exactly 3-4 highlighted segments
- Generate exactly 2-3 AI suggestions
- Be realistic — academic submissions rarely have >60% plagiarism
- If text looks original, give low plagiarism score (10-25%)
`.trim();

        const raw = await callGroqAI(prompt);

        let result;
        try {
            const s = raw.indexOf('{'), e = raw.lastIndexOf('}') + 1;
            result = JSON.parse(raw.slice(s, e));
        } catch {
            return res.status(500).json({ success: false, message: 'AI returned invalid format. Try again later.' });
        }

        // ── 3. Sanitize & compute ─────────────────────────────────────
        const plagiarismScore = Math.min(100, Math.max(0, Number(result.plagiarismScore) || 0));
        const originalScore = 100 - plagiarismScore;
        const paraphrased = Math.min(plagiarismScore, Math.max(0, Number(result.paraphrasedScore) || 0));
        const exactMatch = plagiarismScore - paraphrased;
        const sourcesFound = (result.sources || []).length;

        const sanitized = {
            reportId,
            scannedOn,
            assignmentTitle,
            studentName,
            sourceFileName,
            plagiarismScore,
            originalScore,
            paraphrasedScore: paraphrased,
            exactMatchScore: Math.max(0, exactMatch),
            riskLevel: result.riskLevel || 'Low',
            grade: result.grade || 'B',
            verdict: result.verdict || 'Acceptable',
            sourcesFound,
            sources: (result.sources || []).slice(0, 4),
            sentences: (result.sentences || []).slice(0, 6),
            highlightedSegments: (result.highlightedSegments || []).slice(0, 4),
            aiSuggestions: (result.aiSuggestions || []).slice(0, 3),
            summary: result.summary || '',
            rawText: rawText.slice(0, 3000),
        };

        // ── 4. Log ────────────────────────────────────────────────────
        logAIUsage(req.user._id, 'analytics', {
            type: 'plagiarism_check',
            reportId,
            plagiarismScore,
            sourcesFound,
        });

        res.status(200).json({ success: true, result: sanitized });

    } catch (error) {
        console.error('checkPlagiarism error:', error);
        res.status(500).json({ success: false, message: 'Failed to check plagiarism' });
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// ═══  AI AUTOMATION: SMART NOTIFICATIONS  ══════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════════

// @desc    Draft an AI-generated smart notification for a student or course
// @route   POST /api/ai/draft-notification
// @access  Private (tutor/admin)
export const draftNotification = async (req, res) => {
    try {
        const fs = await import('fs');
        fs.appendFileSync('debug.txt', `[Debug] draftNotification called. GROQ_API_KEY: ${GROQ_API_KEY ? 'exists' : 'missing'}\n`);
        const { targetType, targetId, contextTopic, tone } = req.body;

        if (!contextTopic) {
            return res.status(400).json({ success: false, message: 'Context or reason is required to dispatch the notification.' });
        }

        const prompt = `You are an AI Tutor Assistant drafting a notification message to a student.
Context/Reason: "${contextTopic}"
Requested Tone: "${tone || 'Encouraging'}"

Draft a short, highly professional but empathetic message (max 3-4 sentences). Do not include placeholders like [Student Name], just write the core message body assuming it will be styled in a chat/email bubble.
Do not wrap in markdown or quotes. Return only the plain string text.`;

        const draftedText = await callGroqAI(prompt);

        res.status(200).json({
            success: true,
            message: draftedText.trim().replace(/^["']|["']$/g, '')
        });
    } catch (error) {
        const fs = await import('fs');
        fs.appendFileSync('debug.txt', `[Debug] draftNotification error: ${error.message}\n${error.stack}\n`);
        console.error('Draft Notification error:', error);
        res.status(500).json({ success: false, message: 'AI failed to draft notification.' });
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// ═══  AI COURSE BUILDER  ════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════════

// @desc    Get AI Course Builder stats + recent AI-generated courses
// @route   GET /api/ai/course-builder/stats
// @access  Private (tutor)
export const getCourseBuilderStats = async (req, res) => {
    try {
        const Tutor = (await import('../models/Tutor.js')).default;
        const Course = (await import('../models/Course.js')).default;

        const tutor = await Tutor.findOne({ userId: req.user._id }).select('_id').lean();
        if (!tutor) return res.status(403).json({ success: false, message: 'Tutor profile not found' });

        // Get recent courses
        const recentCourses = await Course.find({ tutorId: tutor._id })
            .sort({ createdAt: -1 })
            .limit(8)
            .select('title level duration enrolledCount status createdAt')
            .lean();

        // Stats
        const totalCourses = await Course.countDocuments({ tutorId: tutor._id });
        const aiGenCount = await AIUsageLog.countDocuments({ userId: req.user._id, action: 'course_builder' });

        const formatted = recentCourses.map(c => {
            const diffMs = Date.now() - new Date(c.createdAt).getTime();
            const diffMin = Math.floor(diffMs / 60000);
            const timeAgo = diffMin < 1 ? 'Just now'
                : diffMin < 60 ? `${diffMin}m ago`
                    : diffMin < 1440 ? `${Math.floor(diffMin / 60)}h ago`
                        : diffMin < 10080 ? `${Math.floor(diffMin / 1440)}d ago`
                            : new Date(c.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
            return { ...c, timeAgo };
        });

        res.status(200).json({
            success: true,
            stats: { totalCourses, aiGenerated: aiGenCount },
            recentCourses: formatted,
        });

    } catch (error) {
        console.error('getCourseBuilderStats error:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch stats' });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// SUBJECTIVE ANSWER CHECKER CONTROLLERS
// Append to aiController.js
// ─────────────────────────────────────────────────────────────────────────────

// @desc    Check / evaluate a subjective answer using AI
// @route   POST /api/ai/subjective-check
// @access  Private (tutor)
// Body: { question, studentAnswer, idealAnswer?, maxMarks?, subject?, gradeLevel? }
export const checkSubjectiveAnswer = async (req, res) => {
    try {
        if (!GROQ_API_KEY) return res.status(500).json({ success: false, message: 'Groq API key not configured' });

        const {
            question,
            studentAnswer,
            idealAnswer = '',
            maxMarks = 10,
            subject = '',
            gradeLevel = '',
        } = req.body;

        if (!question?.trim()) return res.status(400).json({ success: false, message: 'Question is required' });
        if (!studentAnswer?.trim()) return res.status(400).json({ success: false, message: 'Student answer is required' });

        const prompt = `
You are an expert academic evaluator grading a student's subjective answer.

Question: "${question.trim()}"
${subject ? `Subject: ${subject}` : ''}
${gradeLevel ? `Grade Level: ${gradeLevel}` : ''}
Ideal Answer: "${idealAnswer?.trim() || 'Not provided — evaluate based on factual correctness and completeness.'}"
Student Answer: "${studentAnswer.trim()}"
Maximum Marks: ${maxMarks}

Evaluate thoroughly across 4 dimensions. Return ONLY valid JSON (no markdown, no backticks):
{
  "grade": "<letter grade: A+|A|A-|B+|B|B-|C+|C|D|F>",
  "marksAwarded": <number 0 to ${maxMarks}>,
  "percentage": <number 0 to 100>,
  "overallFeedback": "<2-3 sentence overall assessment — encouraging yet honest>",
  "informationRetained": <0-100 integer — how much key info was retained>,
  "difficulty": "<Easy|Balanced|Hard — difficulty of the question>",
  "gradeLevelAssessment": "<e.g. 8th Grade, 10th Grade, College Level — appropriate grade level of the answer>",
  "dimensions": {
    "keyConcepts":      { "score": <0-100>, "stars": <1-5>, "feedback": "<1 sentence>" },
    "clarity":          { "score": <0-100>, "stars": <1-5>, "feedback": "<1 sentence>" },
    "examples":         { "score": <0-100>, "stars": <1-5>, "feedback": "<1 sentence>" },
    "depthOfKnowledge": { "score": <0-100>, "stars": <1-5>, "feedback": "<1 sentence>" }
  },
  "conceptTags": ["<concept 1>", "<concept 2>", "<concept 3>"],
  "tips": "<1-2 sentence tip for improvement>",
  "strengths": ["<strength 1>", "<strength 2>"],
  "improvements": ["<area 1>", "<area 2>"]
}
`.trim();

        const raw = await callGroqAI(prompt);

        let result;
        try {
            const s = raw.indexOf('{'), e = raw.lastIndexOf('}') + 1;
            result = JSON.parse(raw.slice(s, e));
        } catch {
            return res.status(500).json({ success: false, message: 'AI returned invalid format. Try again later.' });
        }

        // Sanitize
        const sanitized = {
            grade: result.grade || 'B',
            marksAwarded: Math.min(Number(result.marksAwarded || 0), maxMarks),
            percentage: Math.min(100, Math.max(0, Number(result.percentage || 0))),
            overallFeedback: result.overallFeedback || '',
            informationRetained: Math.min(100, Math.max(0, Number(result.informationRetained || 0))),
            difficulty: result.difficulty || 'Balanced',
            gradeLevelAssessment: result.gradeLevelAssessment || gradeLevel || 'General',
            dimensions: result.dimensions || {},
            conceptTags: result.conceptTags || [],
            tips: result.tips || '',
            strengths: result.strengths || [],
            improvements: result.improvements || [],
        };

        logAIUsage(req.user._id, 'analytics', {
            type: 'subjective_check',
            subject: subject || 'General',
            maxMarks,
        });

        res.status(200).json({ success: true, result: sanitized });

    } catch (error) {
        console.error('checkSubjectiveAnswer error:', error);
        res.status(500).json({ success: false, message: 'Failed to evaluate answer' });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// REPORT GENERATOR CONTROLLERS
// Append to aiController.js
// Import at top: import GeneratedReport from '../models/GeneratedReport.js';
// ─────────────────────────────────────────────────────────────────────────────

// @desc    Get students + courses for report selector
// @route   GET /api/ai/report-gen/students
// @access  Private (tutor)
export const getReportStudents = async (req, res) => {
    try {
        const { courseId } = req.query;

        const Tutor = (await import('../models/Tutor.js')).default;
        const Course = (await import('../models/Course.js')).default;
        const User = (await import('../models/User.js')).default;

        const tutor = await Tutor.findOne({ userId: req.user._id }).select('_id').lean();
        if (!tutor) return res.status(403).json({ success: false, message: 'Tutor profile not found' });

        const courseFilter = { tutorId: tutor._id };
        if (courseId) courseFilter._id = courseId;
        const courses = await Course.find(courseFilter).select('_id title level').lean();
        const courseIds = courses.map(c => c._id);

        if (courseIds.length === 0) {
            return res.status(200).json({ success: true, students: [], courses: [] });
        }

        // Enrolled students
        const enrollments = await Enrollment.find({ courseId: { $in: courseIds }, status: 'active' })
            .populate('studentId', 'name email profileImage')
            .lean();

        const seen = new Set();
        const students = [];

        for (const enrl of enrollments) {
            const s = enrl.studentId;
            if (!s || seen.has(s._id?.toString())) continue;
            seen.add(s._id.toString());

            const course = courses.find(c => c._id.toString() === enrl.courseId?.toString());
            students.push({
                _id: s._id,
                name: s.name,
                email: s.email,
                avatar: s.profileImage || null,
                course: course?.title || 'Unknown Course',
                courseId: enrl.courseId,
                level: course?.level || '',
                progress: enrl.progress?.percentage || 0,
            });
        }

        // Quick selection presets
        const quickSelections = [
            ...courses.map(c => ({ label: c.title, type: 'course', courseId: c._id })),
            { label: 'Newton\'s Laws Weak Topics', type: 'weak' },
            { label: 'Chemistry Midterm', type: 'custom' },
            { label: 'School Term Progress Report', type: 'progress' },
            { label: 'School Term Progress Report', type: 'progress' },
        ].slice(0, 5);

        res.status(200).json({ success: true, students, courses, quickSelections });

    } catch (error) {
        console.error('getReportStudents error:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch students' });
    }
};

// @desc    Generate AI report for selected students / course
// @route   POST /api/ai/report-gen/generate
// @access  Private (tutor)
// Body: { reportType, studentIds[], courseId?, highlightStrengths, title? }
export const generateReport = async (req, res) => {
    try {
        if (!GROQ_API_KEY) return res.status(500).json({ success: false, message: 'Groq API key not configured' });

        const {
            reportType = 'student',
            studentIds = [],
            courseId,
            highlightStrengths = true,
            title,
            quickSelection = '',
        } = req.body;

        if (reportType === 'student' && (!studentIds || studentIds.length === 0)) {
            return res.status(400).json({ success: false, message: 'Select at least one student' });
        }

        const Tutor = (await import('../models/Tutor.js')).default;
        const Course = (await import('../models/Course.js')).default;
        const User = (await import('../models/User.js')).default;
        const GeneratedReport = (await import('../models/GeneratedReport.js')).default;

        const tutor = await Tutor.findOne({ userId: req.user._id }).select('_id').lean();
        if (!tutor) return res.status(403).json({ success: false, message: 'Tutor profile not found' });

        // Limit to 5 students
        const selectedIds = studentIds.slice(0, 5);

        // Fetch student users
        const users = await User.find({ _id: { $in: selectedIds } })
            .select('_id name email profileImage instituteId').lean();
        const userMap = users.reduce((m, u) => { m[u._id.toString()] = u; return m; }, {});

        // Fetch courses
        const courseFilter = { tutorId: tutor._id };
        if (courseId) courseFilter._id = courseId;
        const courses = await Course.find(courseFilter).select('_id title level').lean();
        const courseIds = courses.map(c => c._id);

        // Lessons
        const lessons = await Lesson.find({ courseId: { $in: courseIds } }).select('_id title courseId').lean();
        const lessonIds = lessons.map(l => l._id);
        const lessonMap = lessons.reduce((m, l) => { m[l._id.toString()] = l; return m; }, {});

        // Quiz performance per student
        const quizAgg = await QuizAttempt.aggregate([
            { $match: { lessonId: { $in: lessonIds }, studentId: { $in: selectedIds.map(id => new mongoose.Types.ObjectId(id)) } } },
            {
                $group: {
                    _id: '$studentId',
                    avgScore: { $avg: '$score' },
                    attempts: { $sum: 1 },
                    passedCount: { $sum: { $cond: ['$isPassed', 1, 0] } },
                    weakLessons: { $addToSet: { $cond: [{ $eq: ['$isPassed', false] }, '$lessonId', null] } },
                    // Per-lesson scores for skill breakdown
                    lessonScores: { $push: { lessonId: '$lessonId', score: '$score' } },
                },
            },
        ]);
        const quizMap = quizAgg.reduce((m, q) => { m[q._id.toString()] = q; return m; }, {});

        // Enrollment progress
        const enrollAgg = await Enrollment.aggregate([
            { $match: { courseId: { $in: courseIds }, studentId: { $in: selectedIds.map(id => new mongoose.Types.ObjectId(id)) } } },
            {
                $group: {
                    _id: '$studentId',
                    avgProgress: { $avg: '$progress.percentage' },
                },
            },
        ]);
        const enrollMap = enrollAgg.reduce((m, e) => { m[e._id.toString()] = e; return m; }, {});

        // Submission grades
        const assignmentIds = await (await import('../models/Assignment.js')).default
            .find({ courseId: { $in: courseIds } }).select('_id').lean()
            .then(as => as.map(a => a._id));

        const subAgg = await Submission.aggregate([
            { $match: { assignmentId: { $in: assignmentIds }, studentId: { $in: selectedIds.map(id => new mongoose.Types.ObjectId(id)) }, status: 'graded' } },
            {
                $group: {
                    _id: '$studentId',
                    avgGrade: { $avg: '$grade' },
                    count: { $sum: 1 },
                },
            },
        ]);
        const subMap = subAgg.reduce((m, s) => { m[s._id.toString()] = s; return m; }, {});

        // ── Build per-student data ──────────────────────────────────
        const studentDataList = selectedIds.map(sid => {
            const user = userMap[sid];
            const quiz = quizMap[sid];
            const enrl = enrollMap[sid];
            const sub = subMap[sid];

            const avgScore = quiz ? Math.round(quiz.avgScore) : 0;
            const progress = enrl ? Math.round(enrl.avgProgress) : 0;
            const avgGrade = sub ? Math.round(sub.avgGrade) : null;

            const weakTopics = (quiz?.weakLessons || [])
                .filter(Boolean)
                .map(wl => lessonMap[wl.toString()]?.title)
                .filter(Boolean)
                .slice(0, 4);

            // Skill breakdown — top 4 lessons with scores
            const lessonScoreMap = {};
            (quiz?.lessonScores || []).forEach(ls => {
                const key = ls.lessonId.toString();
                if (!lessonScoreMap[key]) lessonScoreMap[key] = [];
                lessonScoreMap[key].push(ls.score);
            });
            const skillBreakdown = Object.entries(lessonScoreMap)
                .slice(0, 4)
                .map(([lid, scores], i) => ({
                    topic: lessonMap[lid]?.title || `Topic ${i + 1}`,
                    score: Math.round(scores.reduce((s, x) => s + x, 0) / scores.length),
                    color: ['#EF4444', '#F97316', '#10B981', '#6366F1'][i] || '#8B5CF6',
                }));

            const grade = avgScore >= 90 ? 'A+' : avgScore >= 80 ? 'A' : avgScore >= 70 ? 'B+' : avgScore >= 60 ? 'B' : avgScore >= 50 ? 'C' : 'D';

            return {
                studentId: sid,
                name: user?.name || 'Student',
                email: user?.email || '',
                avatar: user?.profileImage || null,
                avgScore,
                progress,
                avgGrade,
                grade,
                weakTopics,
                skillBreakdown,
                attempts: quiz?.attempts || 0,
            };
        });

        // ── AI Report Generation ────────────────────────────────────
        const studentSummaryText = studentDataList.map(s =>
            `Student: ${s.name}, Avg Score: ${s.avgScore}%, Progress: ${s.progress}%, Weak Topics: ${s.weakTopics.join(', ') || 'None'}`
        ).join('\n');

        const courseName = courseId ? courses.find(c => c._id.toString() === courseId)?.title : 'All Courses';

        const prompt = `
You are an expert academic report generator. Generate a comprehensive report for these students.

Report Type: ${reportType}
${courseId ? `Course: ${courseName}` : 'All Courses'}
Highlight Strengths & Weaknesses: ${highlightStrengths}

Student Data:
${studentSummaryText}

Return ONLY valid JSON (no markdown):
{
  "title": "<report title, max 8 words>",
  "summary": "<3-4 sentence executive summary of the overall class performance>",
  "students": [
    {
      "name": "<student name>",
      "strengths": ["<strength 1>", "<strength 2>"],
      "weaknesses": ["<weakness 1>", "<weakness 2>"],
      "recommendation": "<1-2 sentence personalized recommendation>"
    }
  ]
}

Generate one entry per student in the same order as provided.
`.trim();

        const raw = await callGroqAI(prompt);
        let aiResult;
        try {
            const s = raw.indexOf('{'), e = raw.lastIndexOf('}') + 1;
            aiResult = JSON.parse(raw.slice(s, e));
        } catch {
            aiResult = { title: title || 'Student Performance Report', summary: 'AI report generated.', students: [] };
        }

        // Merge AI + real data
        const mergedStudents = studentDataList.map((sd, i) => {
            const aiStudent = aiResult.students?.[i] || {};
            return {
                studentId: sd.studentId,
                name: sd.name,
                avatar: sd.avatar,
                avgScore: sd.avgScore,
                progress: sd.progress,
                grade: sd.grade,
                strengths: aiStudent.strengths || [],
                weaknesses: aiStudent.weaknesses || sd.weakTopics,
                skillBreakdown: sd.skillBreakdown,
                recommendation: aiStudent.recommendation || '',
            };
        });

        const reportTitle = title || aiResult.title || `${reportType === 'course' ? courseName : studentDataList[0]?.name} — Report`;

        // Save to DB
        const report = await GeneratedReport.create({
            tutorId: tutor._id,
            instituteId: users[0]?.instituteId || null,
            reportType,
            title: reportTitle,
            studentIds: selectedIds,
            studentNames: mergedStudents.map(s => s.name),
            courseId: courseId || null,
            courseName: courseName || '',
            highlightStrengths,
            quickSelection,
            summary: aiResult.summary || '',
            students: mergedStudents,
            status: 'ready',
        });

        logAIUsage(req.user._id, 'analytics', {
            type: 'report_gen',
            reportId: report._id,
            reportType,
            studentCount: selectedIds.length,
        });

        res.status(200).json({
            success: true,
            report: {
                _id: report._id,
                title: reportTitle,
                reportType,
                summary: aiResult.summary || '',
                students: mergedStudents,
                highlightStrengths,
                courseName,
                createdAt: report.createdAt,
            },
        });

    } catch (error) {
        console.error('generateReport error:', error);
        res.status(500).json({ success: false, message: 'Failed to generate report' });
    }
};

// @desc    Get recent generated reports
// @route   GET /api/ai/report-gen/recent
// @access  Private (tutor)
export const getRecentReports = async (req, res) => {
    try {
        const Tutor = (await import('../models/Tutor.js')).default;
        const GeneratedReport = (await import('../models/GeneratedReport.js')).default;

        const tutor = await Tutor.findOne({ userId: req.user._id }).select('_id').lean();
        if (!tutor) return res.status(403).json({ success: false, message: 'Tutor profile not found' });

        const reports = await GeneratedReport.find({ tutorId: tutor._id, status: 'ready' })
            .sort({ createdAt: -1 })
            .limit(10)
            .select('-students -summary')
            .lean();

        const formatted = reports.map(r => {
            const diffMs = Date.now() - new Date(r.createdAt).getTime();
            const diffMin = Math.floor(diffMs / 60000);
            const timeAgo = diffMin < 1 ? 'Just now'
                : diffMin < 60 ? `${diffMin} mins ago`
                    : diffMin < 1440 ? `${Math.floor(diffMin / 60)} hrs ago`
                        : diffMin < 10080 ? `${Math.floor(diffMin / 1440)} days ago`
                            : new Date(r.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });

            return { ...r, timeAgo };
        });

        // Stats
        const totalReports = await GeneratedReport.countDocuments({ tutorId: tutor._id });
        const studentReports = await GeneratedReport.countDocuments({ tutorId: tutor._id, reportType: 'student' });

        res.status(200).json({
            success: true,
            reports: formatted,
            stats: {
                totalReports,
                studentReports,
                courseReports: totalReports - studentReports,
                automatedHours: Math.round(totalReports * 0.3 * 10) / 10,
            },
        });
    } catch (error) {
        console.error('getRecentReports error:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch reports' });
    }
};

// @desc    Delete a report
// @route   DELETE /api/ai/report-gen/:id
// @access  Private (tutor)
export const deleteReport = async (req, res) => {
    try {
        const Tutor = (await import('../models/Tutor.js')).default;
        const GeneratedReport = (await import('../models/GeneratedReport.js')).default;

        const tutor = await Tutor.findOne({ userId: req.user._id }).select('_id').lean();
        if (!tutor) return res.status(403).json({ success: false, message: 'Tutor profile not found' });

        const report = await GeneratedReport.findOneAndDelete({ _id: req.params.id, tutorId: tutor._id });
        if (!report) return res.status(404).json({ success: false, message: 'Report not found' });

        res.status(200).json({ success: true, message: 'Report deleted' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to delete report' });
    }
};

// ── Helper: timeAgo ───────────────────────────────────────────────────────────
function timeAgo(date) {
    const diffMs = Date.now() - new Date(date).getTime();
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return 'Just now';
    if (diffMin < 60) return diffMin + ' mins ago';
    if (diffMin < 1440) return Math.floor(diffMin / 60) + ' hr ago';
    return Math.floor(diffMin / 1440) + 'd ago';
}

// ── Helper: derive riskLevel from attempt ────────────────────────────────────
function deriveRiskLevel(attempt) {
    if (attempt.aiRiskLevel && attempt.aiRiskLevel !== 'Safe') return attempt.aiRiskLevel;
    const tabCount = attempt.tabSwitchCount || 0;
    const events = attempt.proctoringEvents || [];
    const highEvts = events.filter(e => e.severity === 'high').length;
    const medEvts = events.filter(e => e.severity === 'medium').length;
    if (highEvts >= 2 || tabCount >= 5) return 'Cheating Detected';
    if (highEvts >= 1 || medEvts >= 2 || tabCount >= 3) return 'Suspicious Detected';
    if (tabCount >= 1 || events.length >= 1) return 'Low Confidence Detected';
    return 'Safe';
}

// ── Helper: key issues from attempt ──────────────────────────────────────────
function extractKeyIssues(attempt) {
    const issues = [];
    if (attempt.tabSwitchCount > 0) issues.push('Multiple screen switches (' + attempt.tabSwitchCount + 'x)');
    const evtTypes = [...new Set((attempt.proctoringEvents || []).map(e => e.eventType))];
    evtTypes.forEach(t => {
        if (t === 'unauthorized_object') issues.push('Unauthorized object detected');
        else if (t === 'multiple_faces') issues.push('Multiple faces detected');
        else if (t === 'no_face') issues.push('No face detected');
        else if (t === 'audio_anomaly') issues.push('Audio anomaly detected');
    });
    return issues;
}

// @desc    Get proctoring alerts dashboard for tutor
// @route   GET /api/ai/proctoring/alerts
// @access  Private (tutor)
export const getProctoringAlerts = async (req, res) => {
    try {
        const { riskFilter, examFilter, sortBy = 'latest' } = req.query;

        // ── Get tutor's exams ─────────────────────────────────────
        const Tutor = (await import('../models/Tutor.js')).default;
        const Course = (await import('../models/Course.js')).default;

        const tutor = await Tutor.findOne({ userId: req.user._id }).select('_id').lean();
        if (!tutor) return res.status(403).json({ success: false, message: 'Tutor profile not found' });

        const courses = await Course.find({ tutorId: tutor._id }).select('_id').lean();
        const courseIds = courses.map(c => c._id);

        const examFilter_ = { courseId: { $in: courseIds }, status: 'published' };
        if (examFilter) examFilter_._id = examFilter;

        const exams = await Exam.find(examFilter_).select('_id title type').lean();
        const examIds = exams.map(e => e._id);
        const examMap = exams.reduce((m, e) => { m[e._id.toString()] = e; return m; }, {});

        if (examIds.length === 0) {
            return res.status(200).json({
                success: true,
                summary: { cheating: 0, suspicious: 0, lowConfidence: 0, safe: 0, total: 0, flagged: 0, flaggedPct: 0, activeExams: 0, totalTimeProctored: 0 },
                alerts: [], recentSessions: [], exams: [],
            });
        }

        // ── Fetch all attempts ────────────────────────────────────
        const attempts = await ExamAttempt.find({ examId: { $in: examIds } })
            .populate('studentId', 'name email avatar')
            .sort({ submittedAt: -1 })
            .lean();

        // ── Enrich with risk level ────────────────────────────────
        const enriched = attempts.map(a => {
            const riskLevel = deriveRiskLevel(a);
            const keyIssues = extractKeyIssues(a);
            const violationsCount = (a.tabSwitchCount || 0) + (a.proctoringEvents || []).length;
            const exam = examMap[a.examId?.toString()];
            return {
                _id: a._id,
                studentId: a.studentId?._id,
                studentName: a.studentId?.name || 'Student',
                studentAvatar: a.studentId?.avatar || null,
                examId: a.examId,
                examName: exam?.title || 'Unknown Exam',
                riskLevel,
                riskScore: a.aiRiskScore || 0,
                keyIssues,
                violationsCount,
                tabSwitchCount: a.tabSwitchCount || 0,
                proctoringEvents: a.proctoringEvents || [],
                score: a.score,
                totalQuestions: a.answers?.length || 0,
                timeSpent: a.timeSpent || 0,
                submittedAt: a.submittedAt,
                timeAgo: timeAgo(a.submittedAt),
            };
        });

        // ── Filter by risk ────────────────────────────────────────
        let filtered = enriched;
        if (riskFilter && riskFilter !== 'All') {
            filtered = enriched.filter(a => a.riskLevel === riskFilter);
        }

        // ── Sort ──────────────────────────────────────────────────
        if (sortBy === 'risk') {
            const order = { 'Cheating Detected': 0, 'Suspicious Detected': 1, 'Low Confidence Detected': 2, 'Safe': 3 };
            filtered.sort((a, b) => (order[a.riskLevel] ?? 4) - (order[b.riskLevel] ?? 4));
        }

        // ── Summary counts ────────────────────────────────────────
        const cheating = enriched.filter(a => a.riskLevel === 'Cheating Detected').length;
        const suspicious = enriched.filter(a => a.riskLevel === 'Suspicious Detected').length;
        const lowConf = enriched.filter(a => a.riskLevel === 'Low Confidence Detected').length;
        const safe = enriched.filter(a => a.riskLevel === 'Safe').length;
        const total = enriched.length;
        const flagged = cheating + suspicious + lowConf;
        const flaggedPct = total > 0 ? Math.round((flagged / total) * 100) : 0;
        const totalTimeProctored = Math.round(enriched.reduce((s, a) => s + (a.timeSpent || 0), 0) / 60); // hours

        // ── Recent sessions (latest 5 flagged) ───────────────────
        const recentSessions = enriched
            .filter(a => a.riskLevel !== 'Safe')
            .slice(0, 5)
            .map(a => ({
                _id: a._id,
                studentName: a.studentName,
                studentAvatar: a.studentAvatar,
                examName: a.examName,
                riskLevel: a.riskLevel,
                violationsCount: a.violationsCount,
                timeAgo: a.timeAgo,
            }));

        // Log usage
        logAIUsage(req.user._id, 'analytics', { type: 'proctoring_review', attemptCount: total });

        res.status(200).json({
            success: true,
            summary: { cheating, suspicious, lowConfidence: lowConf, safe, total, flagged, flaggedPct, activeExams: exams.length, totalTimeProctored },
            alerts: filtered,
            recentSessions,
            exams: exams.map(e => ({ _id: e._id, title: e.title })),
        });

    } catch (error) {
        console.error('getProctoringAlerts error:', error);
        res.status(500).json({ success: false, message: 'Failed to load proctoring alerts' });
    }
};

// @desc    AI generate proctoring summary for an attempt
// @route   POST /api/ai/proctoring/review/:attemptId/summary
// @access  Private (tutor)
export const generateProctoringAISummary = async (req, res) => {
    try {
        if (!GROQ_API_KEY) return res.status(500).json({ success: false, message: 'Groq API key not configured' });

        const attempt = await ExamAttempt.findById(req.params.attemptId)
            .populate('studentId', 'name')
            .populate('examId', 'title')
            .lean();

        if (!attempt) return res.status(404).json({ success: false, message: 'Attempt not found' });

        const riskLevel = deriveRiskLevel(attempt);
        const keyIssues = extractKeyIssues(attempt);
        const violations = (attempt.tabSwitchCount || 0) + (attempt.proctoringEvents || []).length;

        const prompt = `
You are an AI exam proctoring analyst. Generate a concise integrity report for this exam attempt.

Student: ${attempt.studentId?.name || 'Student'}
Exam: ${attempt.examId?.title || 'Exam'}
Score: ${attempt.score}
Risk Level: ${riskLevel}
Tab Switches: ${attempt.tabSwitchCount || 0}
Total Violations: ${violations}
Key Issues: ${keyIssues.join(', ') || 'None'}
Proctoring Events: ${(attempt.proctoringEvents || []).map(e => e.eventType + ' (' + e.severity + ')').join(', ') || 'None'}

Write a 3-4 sentence professional integrity assessment. State the risk level, describe the suspicious behaviors observed, their likely implications, and recommend whether to: Dismiss / Flag for Review / Escalate for Investigation.
`.trim();

        const summary = await callGroqAI(prompt);

        // Save summary to attempt
        await ExamAttempt.findByIdAndUpdate(req.params.attemptId, { aiProctoringSummary: summary });

        logAIUsage(req.user._id, 'analytics', { type: 'proctoring_summary', attemptId: attempt._id });

        res.status(200).json({ success: true, summary });

    } catch (error) {
        console.error('generateProctoringAISummary error:', error);
        res.status(500).json({ success: false, message: 'Failed to generate summary' });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// COURSE BUILDER CONTROLLERS
// Append to aiController.js
// Import at top: import AICourse from '../models/AICourse.js';
// ─────────────────────────────────────────────────────────────────────────────

// @desc    Generate AI course structure
// @route   POST /api/ai/course-builder/generate
// @access  Private (tutor)
// ─────────────────────────────────────────────────────────────────────────────
// COURSE BUILDER CONTROLLERS
// Append to aiController.js
// ─────────────────────────────────────────────────────────────────────────────

// @desc    Generate AI course AND save to real Course + Lesson DB
// @route   POST /api/ai/course-builder/generate
// @access  Private (tutor)
export const generateAICourse = async (req, res) => {
    try {
        if (!GROQ_API_KEY) return res.status(500).json({ success: false, message: 'Groq API key not configured' });

        const {
            topic,
            subject = '',
            gradeLevel = '',
            difficulty = 'balanced',
            sections = {},
            categoryId,        // ← tutor must pass this
            price = 0,
            language = 'English',
            audience
        } = req.body;

        if (!topic?.trim()) return res.status(400).json({ success: false, message: 'Course topic is required' });
        if (!categoryId) return res.status(400).json({ success: false, message: 'categoryId is required to save course' });

        const Tutor = (await import('../models/Tutor.js')).default;
        const Course = (await import('../models/Course.js')).default;
        const Lesson = (await import('../models/Lesson.js')).default;

        const tutor = await Tutor.findOne({ userId: req.user._id }).select('_id instituteId').lean();
        if (!tutor) return res.status(403).json({ success: false, message: 'Tutor profile not found' });

        const selectedSections = {
            visualLessons: sections.visualLessons !== false,
            practiceQuizzes: sections.practiceQuizzes !== false,
            flashcards: sections.flashcards !== false,
            assignments: sections.assignments !== false,
            conceptSummaries: sections.conceptSummaries !== false,
            formativeAssessments: sections.formativeAssessments !== false,
            includeAIChatbot: sections.includeAIChatbot === true,
        };

        const difficultyLabel = difficulty === 'easy' ? 'Easy (Beginner-friendly)'
            : difficulty === 'focused' ? 'Focused (Deep dive into specific topics)'
                : difficulty === 'advanced' ? 'Advanced (Expert level)'
                    : 'Balanced (Mixed Difficulty)';

        const sectionsList = Object.entries(selectedSections)
            .filter(([, v]) => v)
            .map(([k]) => k.replace(/([A-Z])/g, ' $1').trim())
            .join(', ');

        // ── AI Prompt ─────────────────────────────────────────────────
        const prompt = `
You are an expert curriculum designer. Create a comprehensive course structure.

Course Topic: "${topic.trim()}"
${subject ? `Subject: ${subject}` : ''}
${gradeLevel ? `Target Grade Level: ${gradeLevel}` : ''}
Difficulty: ${difficultyLabel}
Include Sections: ${sectionsList}

Generate a complete, structured course. Return ONLY valid JSON (no markdown, no backticks):
{
  "title": "<engaging course title, max 8 words>",
  "description": "<2-3 sentence course description>",
  "estimatedDuration": "<e.g. 4 weeks, 20 hours>",
  "targetAudience": "<e.g. Grade 8 students, beginners>",
  "whatYouWillLearn": ["<objective 1>", "<objective 2>", "<objective 3>", "<objective 4>"],
  "requirements": ["<prerequisite 1>", "<prerequisite 2>"],
  "modules": [
    {
      "title": "<module title>",
      "description": "<1 sentence module overview>",
      "lessons": [
        {
          "title": "<lesson title>",
          "type": "<video|document|quiz>",
          "duration": "<e.g. 30 mins>",
          "description": "<1 sentence lesson description>",
          "isFree": <true for first lesson of first module, false otherwise>,
          "quizQuestions": [
            {
              "question": "<MCQ question — only include if type is quiz>",
              "options": [
                { "text": "<option A>", "isCorrect": false },
                { "text": "<option B>", "isCorrect": true },
                { "text": "<option C>", "isCorrect": false },
                { "text": "<option D>", "isCorrect": false }
              ],
              "explanation": "<why correct answer is right>",
              "points": 1
            }
          ]
        }
      ]
    }
  ]
}

Rules:
- Generate exactly 3-4 modules
- Each module should have 3-4 lessons
- Lesson types: use "video" for concept lessons, "document" for reading/notes/flashcards, "quiz" for practice/assessment
- For quiz lessons: include 3-5 quizQuestions with proper MCQ format
- For non-quiz lessons: quizQuestions should be empty array []
- First lesson of first module should have isFree: true
- Make content specific to the topic and grade level
`.trim();

        const raw = await callGroqAI(prompt);

        let parsed;
        try {
            const s = raw.indexOf('{'), e = raw.lastIndexOf('}') + 1;
            parsed = JSON.parse(raw.slice(s, e));
        } catch {
            return res.status(500).json({ success: false, message: 'AI returned invalid format. Try again later.' });
        }

        // ── Get user info ─────────────────────────────────────────────
        const User = (await import('../models/User.js')).default;
        const user = await User.findById(req.user._id).select('instituteId').lean();
        const instituteId = user?.instituteId || tutor.instituteId || null;

        let resolvedAudience;
        if (audience) {
            const normalized = normalizeAudienceInput({
                audience,
                scope: audience.scope,
                instituteId: audience.instituteId || instituteId,
            }, {
                defaultScope: instituteId ? AUDIENCE_SCOPES.INSTITUTE : AUDIENCE_SCOPES.GLOBAL,
                defaultInstituteId: instituteId,
            });
            resolvedAudience = validateAudience(normalized, { requireInstituteId: false });
            if (!instituteId) {
                resolvedAudience.scope = AUDIENCE_SCOPES.GLOBAL;
                resolvedAudience.instituteId = null;
            }
        } else {
            resolvedAudience = {
                scope: instituteId ? AUDIENCE_SCOPES.INSTITUTE : AUDIENCE_SCOPES.GLOBAL,
                instituteId: instituteId || null,
                batchIds: [],
                studentIds: [],
            };
        }

        const isGlobal = resolvedAudience.scope === AUDIENCE_SCOPES.GLOBAL;
        const resolvedInstituteId = isGlobal ? null : (resolvedAudience.instituteId || instituteId || null);

        // ── Build modules array for Course ────────────────────────────
        const mongoose = (await import('mongoose')).default;

        const modulesWithIds = (parsed.modules || []).map((mod, mIdx) => ({
            _id: new mongoose.Types.ObjectId(),
            title: mod.title || `Module ${mIdx + 1}`,
            description: mod.description || '',
            order: mIdx,
        }));

        // ── Create Course (same as manual createCourse) ───────────────
        const levelMap = {
            easy: 'beginner',
            balanced: 'intermediate',
            focused: 'intermediate',
            advanced: 'advanced',
        };

        const course = await Course.create({
            title: parsed.title || topic,
            description: parsed.description || '',
            categoryId,
            tutorId: tutor._id,
            instituteId: resolvedInstituteId,
            createdBy: req.user._id,
            price: Number(price) || 0,
            isFree: Number(price) === 0,
            level: levelMap[difficulty] || 'beginner',
            language: language || 'English',
            duration: 0,
            whatYouWillLearn: (parsed.whatYouWillLearn || []).slice(0, 6),
            requirements: (parsed.requirements || []).slice(0, 4),
            modules: modulesWithIds,
            status: 'published',
            isAIGenerated: true,
            visibility: isGlobal ? 'public' : 'institute',
            audience: resolvedAudience,
        });

        // ── Create Lessons for each module ────────────────────────────
        const createdLessons = [];
        let globalOrder = 0;

        for (let mIdx = 0; mIdx < (parsed.modules || []).length; mIdx++) {
            const mod = parsed.modules[mIdx];
            const moduleDoc = modulesWithIds[mIdx];

            for (let lIdx = 0; lIdx < (mod.lessons || []).length; lIdx++) {
                const aiLesson = mod.lessons[lIdx];

                // Build content object based on lesson type
                let content = {};
                const lessonType = aiLesson.type || 'video';

                if (lessonType === 'video') {
                    content = {
                        videoUrl: '',          // tutor will add later
                        duration: 0,
                        attachments: [],
                    };
                } else if (lessonType === 'quiz') {
                    // Build proper quiz content
                    const questions = (aiLesson.quizQuestions || []).map(q => ({
                        question: q.question || '',
                        options: (q.options || []).map(opt => ({
                            text: opt.text || '',
                            isCorrect: opt.isCorrect || false,
                        })),
                        explanation: q.explanation || '',
                        points: q.points || 1,
                    }));

                    content = {
                        quiz: {
                            title: aiLesson.title || 'Quiz',
                            description: aiLesson.description || '',
                            passingScore: 70,
                            timeLimit: null,
                            shuffleQuestions: false,
                            shuffleOptions: false,
                            showCorrectAnswers: true,
                            allowRetake: true,
                            maxAttempts: null,
                            questions,
                            totalPoints: questions.reduce((s, q) => s + q.points, 0),
                        },
                        attachments: [],
                    };
                } else {
                    // document type — reading, notes, flashcards, summary
                    content = {
                        documents: [],
                        attachments: [{
                            name: `${aiLesson.title} — AI Generated Notes`,
                            url: '',  // tutor will upload actual file later
                            type: 'text/plain',
                        }].filter(a => false), // start empty, tutor uploads
                        attachments: [],
                    };
                }

                try {
                    const lesson = await Lesson.create({
                        courseId: course._id,
                        moduleId: moduleDoc._id,
                        title: aiLesson.title || `Lesson ${lIdx + 1}`,
                        description: aiLesson.description || '',
                        type: lessonType,
                        content,
                        order: globalOrder++,
                        isFree: aiLesson.isFree || (mIdx === 0 && lIdx === 0),
                        isPublished: true,
                    });
                    createdLessons.push(lesson);
                } catch (lessonErr) {
                    console.error(`Lesson create error (${aiLesson.title}):`, lessonErr.message);
                    // Continue — don't fail entire course for one lesson
                }
            }
        }

        // ── Log AI usage ──────────────────────────────────────────────
        logAIUsage(req.user._id, 'analytics', {
            type: 'course_builder',
            courseId: course._id,
            topic,
            gradeLevel,
            lessonsCount: createdLessons.length,
        });

        res.status(200).json({
            success: true,
            course: {
                _id: course._id,
                title: course.title,
                description: course.description,
                isAIGenerated: true,
                status: course.status,
                level: course.level,
                whatYouWillLearn: course.whatYouWillLearn,
                modules: modulesWithIds.map((mod, i) => ({
                    ...mod,
                    lessons: createdLessons
                        .filter(l => l.moduleId.toString() === mod._id.toString())
                        .map(l => ({
                            _id: l._id,
                            title: l.title,
                            type: l.type,
                            description: l.description,
                            isFree: l.isFree,
                            order: l.order,
                        })),
                })),
                estimatedDuration: parsed.estimatedDuration || '',
                targetAudience: parsed.targetAudience || '',
                topic,
                subject,
                gradeLevel,
                difficulty,
                sections: selectedSections,
                lessonsCreated: createdLessons.length,
                createdAt: course.createdAt,
            },
        });

    } catch (error) {
        console.error('generateAICourse error:', error);
        res.status(500).json({ success: false, message: 'Failed to generate course' });
    }
};

// getRecentAICourses — AICourse → Course model
export const getRecentAICourses = async (req, res) => {
    try {
        const { limit = 10 } = req.query;

        const Tutor = (await import('../models/Tutor.js')).default;
        const Course = (await import('../models/Course.js')).default;

        const tutor = await Tutor.findOne({ userId: req.user._id }).select('_id').lean();
        if (!tutor) return res.status(403).json({ success: false, message: 'Tutor profile not found' });

        // ── Sirf AI generated courses fetch karo ─────────────────────
        const courses = await Course.find({ tutorId: tutor._id, isAIGenerated: true })
            .sort({ createdAt: -1 })
            .limit(Number(limit))
            .select('_id title description gradeLevel subject level status createdAt isAIGenerated modules')
            .lean();

        const formatted = courses.map(c => {
            const diffMs = Date.now() - new Date(c.createdAt).getTime();
            const diffMin = Math.floor(diffMs / 60000);
            const timeAgo = diffMin < 1 ? 'Just now'
                : diffMin < 60 ? `${diffMin}m ago`
                    : diffMin < 1440 ? `${Math.floor(diffMin / 60)}h ago`
                        : diffMin < 10080 ? `${Math.floor(diffMin / 1440)}d ago`
                            : new Date(c.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });

            return {
                _id: c._id,
                title: c.title,
                description: c.description,
                gradeLevel: c.gradeLevel || '',   // Course model mein nahi hai — empty string fallback
                subject: c.subject || '',   // Same
                level: c.level || '',
                status: c.status,
                moduleCount: c.modules?.length || 0,
                isAIGenerated: true,
                timeAgo,
                createdAt: c.createdAt,
            };
        });

        // ── Stats ─────────────────────────────────────────────────────
        const total = await Course.countDocuments({ tutorId: tutor._id, isAIGenerated: true });
        const timeSaved = Math.round(total * 0.7);
        const shareCount = Math.round(total * 35.7);

        res.status(200).json({
            success: true,
            courses: formatted,
            stats: { total, timeSaved, shareCount },
        });

    } catch (error) {
        console.error('getRecentAICourses error:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch courses' });
    }
};

// deleteAICourse — AICourse → Course model

export const deleteAICourse = async (req, res) => {
    try {
        const Tutor = (await import('../models/Tutor.js')).default;
        const Course = (await import('../models/Course.js')).default;

        const tutor = await Tutor.findOne({ userId: req.user._id }).select('_id').lean();
        if (!tutor) return res.status(403).json({ success: false, message: 'Tutor profile not found' });

        // Verify ownership
        const course = await Course.findOne({ _id: req.params.id, tutorId: tutor._id, isAIGenerated: true });
        if (!course) return res.status(404).json({ success: false, message: 'AI course not found' });

        // Enrollment check — enrolled students hain toh delete block karo
        const enrollmentCount = await Enrollment.countDocuments({ courseId: course._id });
        if (enrollmentCount > 0) {
            return res.status(400).json({
                success: false,
                message: `Cannot delete — ${enrollmentCount} students are enrolled in this course`,
            });
        }

        // Delete all lessons first
        await Lesson.deleteMany({ courseId: course._id });

        // Delete course
        await course.deleteOne();

        res.status(200).json({ success: true, message: 'AI course and its lessons deleted successfully' });

    } catch (error) {
        console.error('deleteAICourse error:', error);
        res.status(500).json({ success: false, message: 'Failed to delete course' });
    }
};

// @desc    Super Admin Agentic Chat (God Mode)
// @route   POST /api/ai/superadmin-coordinator
export const superAdminCoordinatorChat = async (req, res) => {
    try {
        const { message, history = [] } = req.body;

        if (!message) {
            return res.status(400).json({ success: false, message: 'Message is required' });
        }

        const User = (await import('../models/User.js')).default;
        const Institute = (await import('../models/Institute.js')).default;
        const Course = (await import('../models/Course.js')).default;
        const Enrollment = (await import('../models/Enrollment.js')).default;
        const { agentTools } = await import('../services/aiAgentTools.js');

        const totalStudents = await User.countDocuments({ role: 'student' });
        const totalTutors = await User.countDocuments({ role: 'tutor' });
        const totalInstitutes = await Institute.countDocuments();

        const thirtyDaysFromNow = new Date();
        thirtyDaysFromNow.setDate(thirtyDaysFromNow.getDate() + 30);

        const expiringInstitutes = await Institute.find({
            subscriptionExpiresAt: { $lt: thirtyDaysFromNow, $gt: new Date() },
            isActive: true
        }).select('name subscriptionExpiresAt contactEmail');

        const expiringListStr = expiringInstitutes.length > 0
            ? expiringInstitutes.map(inst => `- ${inst.name} (Contact: ${inst.contactEmail}, Expires On: ${new Date(inst.subscriptionExpiresAt).toLocaleDateString()})`).join('\n')
            : 'No institutes are expiring in the next 30 days.';

        const suspendedInstitutesCount = await Institute.countDocuments({ isActive: false });
        const blockedUsersCount = await User.countDocuments({ isBlocked: true });

        const totalActiveCourses = await Course.countDocuments({ status: 'published' });
        const totalEnrollments = await Enrollment.countDocuments();

        const platformState = `LIVE STATS: Students=${totalStudents}, Tutors=${totalTutors}, Institutes=${totalInstitutes}, Courses(published)=${totalActiveCourses}, Enrollments=${totalEnrollments}, SuspendedInstitutes=${suspendedInstitutesCount}, BlockedUsers=${blockedUsersCount}. EXPIRING(30days): ${expiringListStr}`;

        const systemPrompt = {
            role: 'system',
            content: `You are the Sapience LMS Super Admin AI Coordinator - an elite, agentic AI assistant designed exclusively for the platform owner/super admin.
You monitor the entire SaaS platform's health and provide deeply analytical, operational, and actionable advice.

${platformState}

DATABASE SCHEMA MAP (For runDynamicAnalytics):
- User: { _id, name, email, role: 'student'|'tutor'|'admin', isBlocked: boolean, createdAt: date }
- Institute: { _id, name, isActive: boolean, subscriptionPlan: string, createdAt: date }
- Course: { _id, title, category, price: number, status: 'published'|'draft', createdAt: date }
- Enrollment: { _id, studentId, courseId, amountPaid: number, enrolledAt: date }

THINKING PROCESS & STRICT LIMITATIONS:
1. Is it a QUESTION looking for data? -> USE READ-ONLY TOOLS. DO NOT GENERATE JSON ACTION BLOCKS.
2. Is it a DIRECT COMMAND? -> Use tools to find the ID, then output the JSON Action Block.
3. BULK OR MULTIPLE COMMANDS: You can ONLY generate MAXIMUM ONE (1) JSON action block per response. If the admin asks to perform multiple actions (e.g., "Block user A and Suspend Institute B"), politely refuse. Ask them to process one action at a time.
4. DATA LIMITATION AWARENESS: Tools like getUsersList and searchInstitutes only return the top 10-15 results to save bandwidth. NEVER claim that these are "all" the records. Always clarify that you are showing a limited preview.
5. GHOST TARGET PREVENTION: NEVER output a JSON action block if you cannot find the exact, valid 24-character hex MongoDB ID. If a user or institute is not found, apologize and stop.

READ-ONLY TOOLS (BACKGROUND API CALLS):
- searchUsers(query): Find user details by name/email.
- getUsersList(role, status): Get a list of users (Max 15).
- getInstituteDetails(instituteName): Get ONE institute's full details.
- searchInstitutes(status): Search/List multiple institutes (Max 10).
- getCourseMetrics(courseName): Enrollment stats for a course.
- getLiveRadar(): See all active live sessions RIGHT NOW.
- checkSystemAlerts(): Get expiring subscriptions & AI quota alerts.
- searchExams(query): Exam pass rates.
- runDynamicAnalytics(modelName, pipeline): 🌟 Use this ONLY for complex reports (e.g., "Total revenue", "Top 5 courses by price"). Provide a strict MongoDB aggregation pipeline.
- searchSemanticInsights(searchQuery): 🌟 RAG Tool. Use this ONLY for reading emotions, patterns, or qualitative feedback from reviews (e.g., "Why are ratings dropping?").

DESTRUCTIVE ACTIONS (STRICT UI BUTTON TRIGGERS):
You DO NOT have the power to execute blocks or suspensions. You can ONLY stage them for the admin's approval.
NEVER say "Executing the action...". Instead, say "I have staged the action for your approval."

When explicitly commanded to block/unblock a user or suspend/activate an institute:
1. Search first to get the valid 24-character hex ID.
2. At the VERY END of your response, output ONE EXACT Markdown JSON block (and nothing else after it):

\`\`\`json
{
  "action": "block_user",
  "targetId": "<real_mongo_id>",
  "operation": "Block"
}
\`\`\`

3. Allowed "action" names: 'suspend_institute', 'block_user'.
4. Allowed "operation" names: 'Block', 'Unblock', 'Suspend', 'Activate'.`
        };

        // Filter out ANY previous assistant tool call messages - they cause Groq 400 bad request formatting errors
        const formattedHistory = [];
        for (const msg of history.slice(-4)) {
            if (msg.role === 'user') {
                formattedHistory.push({ role: 'user', content: String(msg.content).slice(0, 800) });
            } else if (msg.role === 'assistant' || msg.role === 'coordinator' || msg.role === 'tutor') {
                // If it has a json action block, strip it so the model doesn't over-generate action blocks
                let cleanContent = String(msg.content).replace(/```json[\s\S]*?```/g, '').trim();
                if (cleanContent) {
                    formattedHistory.push({ role: 'assistant', content: cleanContent.slice(0, 800) });
                }
            }
        }

        // ── n8n Proxy Logic with Native Fallback ──
        const n8nWebhookUrl = process.env.N8N_COORDINATOR_WEBHOOK_URL;
        
        if (n8nWebhookUrl) {
            try {
                console.log("➡️ Proxying message to n8n multi-agent webhook:", n8nWebhookUrl);
                const axios = (await import('axios')).default;
                
                const headers = {};
                if (process.env.N8N_API_KEY) {
                    headers['x-n8n-api-key'] = process.env.N8N_API_KEY;
                }

                const n8nResponse = await axios.post(n8nWebhookUrl, {
                    message,
                    sender: req.user._id,
                    role: req.user.role
                }, {
                    headers,
                    timeout: 25000
                });

                if (n8nResponse.data && (n8nResponse.data.reply || n8nResponse.data.output)) {
                    const finalReply = n8nResponse.data.reply || n8nResponse.data.output;
                    return res.status(200).json({
                        success: true,
                        reply: finalReply,
                        platformStateFootprint: {
                            totalStudents, totalTutors, totalInstitutes, totalActiveCourses, expiringInstitutesCount: expiringInstitutes.length
                        }
                    });
                }
            } catch (n8nError) {
                console.error("⚠️ n8n Webhook Error, falling back to local OpenAI thread:", n8nError.message);
            }
        }

        // ── Fallback: Local OpenAI Thread ──
        const messages = [
            systemPrompt,
            ...formattedHistory,
            { role: 'user', content: message }
        ];

        const responseText = await callOpenAIWithTools(messages, agentTools);

        res.status(200).json({
            success: true,
            reply: responseText,
            platformStateFootprint: {
                totalStudents, totalTutors, totalInstitutes, totalActiveCourses, expiringInstitutesCount: expiringInstitutes.length
            }
        });

    } catch (error) {
        console.error('superAdminCoordinatorChat error:', error.message);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

// @desc    Perform Semantic Vector Search on Reviews (RAG)
// @route   POST /api/ai/semantic-search
export const getSemanticSearch = async (req, res) => {
    try {
        const { searchQuery, query } = req.body;
        const targetQuery = searchQuery || query;
        if (!targetQuery) {
            return res.status(400).json({ success: false, message: 'Query is required' });
        }

        const { searchSemanticInsights } = await import('../services/aiAgentTools.js');
        const resultsStr = await searchSemanticInsights(targetQuery);
        const results = JSON.parse(resultsStr);

        res.status(200).json({ success: true, results });
    } catch (error) {
        console.error('getSemanticSearch error:', error.message);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

// @desc    Get Platform Analytics (For n8n Superadmin monitoring)
// @route   POST /api/ai/analytics
export const getPlatformAnalytics = async (req, res) => {
    try {
        const User = (await import('../models/User.js')).default;
        const Institute = (await import('../models/Institute.js')).default;
        const Course = (await import('../models/Course.js')).default;
        const Enrollment = (await import('../models/Enrollment.js')).default;

        const totalStudents = await User.countDocuments({ role: 'student' });
        const totalTutors = await User.countDocuments({ role: 'tutor' });
        const totalInstitutes = await Institute.countDocuments();
        const suspendedInstitutesCount = await Institute.countDocuments({ isActive: false });
        const blockedUsersCount = await User.countDocuments({ isBlocked: true });
        const totalActiveCourses = await Course.countDocuments({ status: 'published' });
        const totalEnrollments = await Enrollment.countDocuments();

        res.status(200).json({
            success: true,
            metrics: {
                totalStudents,
                totalTutors,
                totalInstitutes,
                suspendedInstitutes: suspendedInstitutesCount,
                blockedUsers: blockedUsersCount,
                activeCourses: totalActiveCourses,
                totalEnrollments
            }
        });
    } catch (error) {
        console.error('getPlatformAnalytics error:', error.message);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

// @route   POST /api/ai/execute-action
export const executeAIAction = async (req, res) => {
    try {
        const { action, targetId } = req.body;

        if (!action || !targetId) {
            return res.status(400).json({ success: false, message: 'Action and Target ID are required' });
        }

        // 🌟 CRITICAL FIX: Validate ObjectId before querying DB to prevent CastError crashes
        if (!mongoose.Types.ObjectId.isValid(targetId)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid Target ID format. The AI failed to provide a valid MongoDB ID.'
            });
        }

        const User = (await import('../models/User.js')).default;
        const Institute = (await import('../models/Institute.js')).default;

        let resultMsg = "Action executed successfully";

        if (action === "suspend_institute") {
            const institute = await Institute.findById(targetId);
            if (!institute) return res.status(404).json({ success: false, message: 'Institute not found' });
            institute.isActive = !institute.isActive; // Toggle
            await institute.save();
            resultMsg = `Institute ${institute.name} has been ${institute.isActive ? 'activated' : 'suspended'}.`;
        }
        else if (action === "block_user") {
            const user = await User.findById(targetId);
            if (!user) return res.status(404).json({ success: false, message: 'User not found' });

            user.isBlocked = !user.isBlocked; // Toggle status
            await user.save();

            resultMsg = `User ${user.name} has been ${user.isBlocked ? 'blocked' : 'unblocked'}.`;
        }
        else {
            return res.status(400).json({ success: false, message: 'Unknown action type requested' });
        }

        res.status(200).json({ success: true, message: resultMsg });

    } catch (error) {
        console.error('executeAIAction error:', error);
        res.status(500).json({ success: false, message: 'Failed to execute AI action' });
    }
};

// @desc    Generate Proactive Daily AI Report (For Cron Job)
export const generateDailyAIReport = async () => {
    try {
        console.log("🤖 AI Cron Agent: Waking up to generate daily report...");
        
        const User = (await import('../models/User.js')).default;
        const Institute = (await import('../models/Institute.js')).default;
        const Enrollment = (await import('../models/Enrollment.js')).default;
        const { agentTools } = await import('../services/aiAgentTools.js');

        // Basic snapshot fetch karte hain
        const totalStudents = await User.countDocuments({ role: 'student' });
        const totalInstitutes = await Institute.countDocuments();
        
        const platformState = `DAILY SNAPSHOT: Total Students=${totalStudents}, Total Institutes=${totalInstitutes}.`;

        const systemPrompt = {
            role: 'system',
            content: `You are the Sapience LMS AI Coordinator.
Your task is to generate a proactive "Daily Morning Briefing" for the Super Admin.
${platformState}

INSTRUCTIONS:
1. Use your tools (like checkSystemAlerts, searchInstitutes) to check if any institutes are expiring soon or suspended.
2. Write a crisp, motivating 3-4 line summary. 
3. Address the Super Admin with a "Good Morning!". 
4. Highlight any immediate action items (e.g., "1 institute is expiring today").
5. DO NOT generate JSON action blocks. Keep it strictly conversational and informative.`
        };

        const messages = [
            systemPrompt,
            { role: 'user', content: "Generate today's morning briefing and check for critical system alerts." }
        ];

        // Tumhara existing OpenAI helper use kar rahe hain
        const responseText = await callOpenAIWithTools(messages, agentTools);
        return responseText;
        
    } catch (error) {
        console.error("Cron AI Error:", error.message);
        return null;
    }
};

// @desc    Get AI Generated Daily Briefings
// @route   GET /api/ai/briefings
export const getAIBriefings = async (req, res) => {
    try {
        const Notification = (await import('../models/Notification.js')).default;
        
        // Sirf wahi notifications laao jo AI ne generate ki hain
        const briefings = await Notification.find({
            userId: req.user._id, 
            title: "🧠 AI Morning Briefing" // Exact match with cron job title
        })
        .sort({ createdAt: -1 }) // Sabse nayi pehle
        .limit(30) // Last 30 days
        .lean();

        res.status(200).json({ success: true, briefings });
    } catch (error) {
        console.error('getAIBriefings error:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch AI briefings' });
    }
};

// @desc    Send an AI-generated smart notification to a student
// @route   POST /api/ai/send-notification
// @access  Private (tutor/admin)
export const sendNotification = async (req, res) => {
    try {
        const { targetStudentName, message, tone } = req.body;

        if (!message) {
            return res.status(400).json({ success: false, message: 'Message content is required.' });
        }

        // Try to find the student in User records
        const User = (await import('../models/User.js')).default;
        const student = await User.findOne({ 
            name: { $regex: new RegExp(targetStudentName, 'i') }, 
            role: 'student' 
        });

        if (!student) {
            return res.status(404).json({ success: false, message: `Student '${targetStudentName}' not found.` });
        }

        const Tutor = (await import('../models/Tutor.js')).default;
        const tutor = await Tutor.findOne({ userId: req.user.id || req.user._id }).select('_id').lean();

        const { createNotification } = await import('./notificationController.js');
        await createNotification({
            userId: student._id,
            type: 'direct_message',
            title: `AI check-in (${tone || 'Encouraging'})`,
            message: message.trim(),
            data: {
                extras: {
                    tutorId: tutor ? String(tutor._id) : undefined
                }
            }
        });

        res.status(200).json({
            success: true,
            message: 'Notification successfully delivered to student dashboard!'
        });
    } catch (error) {
        console.error('Send Notification error:', error);
        res.status(500).json({ success: false, message: 'Failed to send notification.' });
    }
};

// @desc    Get currently active exam sessions for tutor
// @route   GET /api/ai/proctoring/live-sessions
// @access  Private (tutor)
export const getActiveProctoringSessions = async (req, res) => {
    try {
        const Tutor = (await import('../models/Tutor.js')).default;
        const Course = (await import('../models/Course.js')).default;
        const User = (await import('../models/User.js')).default;
        const { Exam } = await import('../models/Exam.js');
        const { getActiveSessions } = await import('../services/socketService.js');

        const tutor = await Tutor.findOne({ userId: req.user.id || req.user._id }).select('_id').lean();
        if (!tutor) {
          return res.status(403).json({ success: false, message: 'Tutor profile not found' });
        }

        const courses = await Course.find({ tutorId: tutor._id }).select('_id').lean();
        const courseIds = courses.map(c => c._id.toString());

        // Fetch exams belonging to either tutor's courses OR matching tutorId directly
        const tutorExams = await Exam.find({
            $or: [
                { courseId: { $in: courseIds } },
                { tutorId: tutor._id }
            ]
        }).select('_id title duration isProctoringEnabled').lean();
        
        const examIds = tutorExams.map(e => e._id.toString());
        const examMap = tutorExams.reduce((m, e) => { m[e._id.toString()] = e; return m; }, {});

        const rawSessions = getActiveSessions(); // Array of { studentId, socketId, examId, startTime }
        
        // Filter sessions that are writing the tutor's exams
        const filteredSessions = rawSessions.filter(s => examIds.includes(s.examId));

        if (filteredSessions.length === 0) {
            return res.status(200).json({
                success: true,
                sessions: []
            });
        }

        // Fetch student user details
        const studentIds = filteredSessions.map(s => s.studentId);
        const students = await User.find({ _id: { $in: studentIds } }).select('_id name email profileImage').lean();
        const studentMap = students.reduce((m, s) => { m[s._id.toString()] = s; return m; }, {});

        const enrichedSessions = filteredSessions.map(s => {
            const student = studentMap[s.studentId];
            const exam = examMap[s.examId];
            return {
                studentId: s.studentId,
                socketId: s.socketId,
                examId: s.examId,
                studentName: student?.name || 'Student',
                studentEmail: student?.email || '',
                studentAvatar: student?.profileImage || null,
                examTitle: exam?.title || 'Unknown Exam',
                examDuration: exam?.duration || 0,
                startTime: s.startTime,
                elapsedSeconds: Math.floor((Date.now() - s.startTime) / 1000)
            };
        });

        res.status(200).json({
            success: true,
            sessions: enrichedSessions
        });
    } catch (error) {
        console.error('getActiveProctoringSessions error:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch active proctoring sessions' });
    }
};

// @desc    Forcefully terminate a student's active exam session
// @route   POST /api/ai/proctoring/terminate-session
// @access  Private (tutor)
export const terminateExamSession = async (req, res) => {
    try {
        const { studentId, examId, reason = 'Academic dishonesty detected' } = req.body;
        if (!studentId || !examId) {
            return res.status(400).json({ success: false, message: 'studentId and examId are required' });
        }

        const Tutor = (await import('../models/Tutor.js')).default;
        const { Exam } = await import('../models/Exam.js');
        const { getIO } = await import('../services/socketService.js');

        const tutor = await Tutor.findOne({ userId: req.user.id || req.user._id }).select('_id').lean();
        if (!tutor) return res.status(403).json({ success: false, message: 'Tutor profile not found' });

        const exam = await Exam.findById(examId).populate('courseId').lean();
        if (!exam) {
            return res.status(404).json({ success: false, message: 'Exam not found' });
        }

        // Verify ownership
        if (exam.courseId?.tutorId?.toString() !== tutor._id.toString()) {
            return res.status(403).json({ success: false, message: 'Unauthorized: This exam does not belong to your course' });
        }

        const io = getIO();
        if (io) {
            console.log(`🔌 Emitting exam_terminated to user_${studentId} for exam ${examId}`);
            io.to(`user_${studentId}`).emit('exam_terminated', {
                examId,
                reason
            });
        }

        res.status(200).json({
            success: true,
            message: 'Termination command sent successfully'
        });
    } catch (error) {
        console.error('terminateExamSession error:', error);
        res.status(500).json({ success: false, message: 'Failed to terminate session' });
    }
};
