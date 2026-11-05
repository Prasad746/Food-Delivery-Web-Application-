import { test, describe } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"

const chatbotSource = fs.readFileSync(
    new URL("../../frontend/src/components/SupportChatbot.jsx", import.meta.url),
    "utf8"
)
const userDashboardSource = fs.readFileSync(
    new URL("../../frontend/src/components/UserDashboard.jsx", import.meta.url),
    "utf8"
)
const backendPackage = fs.readFileSync(
    new URL("../package.json", import.meta.url),
    "utf8"
)
const frontendPackage = fs.readFileSync(
    new URL("../../frontend/package.json", import.meta.url),
    "utf8"
)

describe("support chatbot frontend", () => {
    test("is integrated into the customer dashboard", () => {
        assert.match(userDashboardSource, /import SupportChatbot from '\.\/SupportChatbot'/)
        assert.match(userDashboardSource, /<SupportChatbot \/>/)
        assert.match(chatbotSource, /Vingo Support/)
    })

    test("posts authenticated messages through the shared axios client", () => {
        assert.match(chatbotSource, /import api from '\.\.\/utils\/axiosInstance'/)
        assert.match(chatbotSource, /api\.post\('\/api\/support\/chat'/)
        assert.match(chatbotSource, /const payload = \{ message: text \}/)
        assert.match(chatbotSource, /payload\.orderId = orderId/)
        assert.match(chatbotSource, /Array\.isArray\(data\.quickReplies\)/)
        assert.match(chatbotSource, /Array\.isArray\(data\.links\)/)
    })

    test("renders messages, quick actions, links, and a bounded input", () => {
        assert.match(chatbotSource, /DEFAULT_QUICK_REPLIES/)
        assert.match(chatbotSource, /handleQuickReply/)
        assert.match(chatbotSource, /handleLink/)
        assert.match(chatbotSource, /MAX_MESSAGE_LENGTH = 500/)
        assert.match(chatbotSource, /maxLength=\{MAX_MESSAGE_LENGTH\}/)
        assert.match(chatbotSource, /whitespace-pre-wrap/)
        assert.match(chatbotSource, /order, payment, and app help/i)
    })

    test("shows loading, error, retry, and clear-conversation states", () => {
        assert.match(chatbotSource, /Vingo Support is typing/)
        assert.match(chatbotSource, /aria-busy=\{isSending\}/)
        assert.match(chatbotSource, /Support chat is unavailable right now/)
        assert.match(chatbotSource, /handleRetry/)
        assert.match(chatbotSource, /appendUserMessage: false/)
        assert.match(chatbotSource, /clearConversation/)
        assert.match(chatbotSource, /setMessages\(\[createWelcomeMessage\(\)\]\)/)
    })

    test("only navigates to internal application links and closes the panel", () => {
        assert.match(chatbotSource, /path\.startsWith\('\/'\)/)
        assert.match(chatbotSource, /path\.startsWith\('\/\/'\)/)
        assert.match(chatbotSource, /navigate\(path\)/)
        assert.match(chatbotSource, /setIsOpen\(false\)/)
    })

    test("is responsive and keyboard accessible", () => {
        assert.match(chatbotSource, /fixed bottom-24 right-4/)
        assert.match(chatbotSource, /w-\[calc\(100vw-2rem\)\]/)
        assert.match(chatbotSource, /max-w-\[400px\]/)
        assert.match(chatbotSource, /aria-label="Vingo customer support chat"/)
        assert.match(chatbotSource, /aria-label="Send message"/)
        assert.match(chatbotSource, /event\.key === 'Escape'/)
        assert.match(chatbotSource, /<form/)
    })

    test("uses a rule-based backend without adding an AI or external chatbot dependency", () => {
        assert.doesNotMatch(backendPackage, /openai|anthropic|langchain|dialogflow/i)
        assert.doesNotMatch(frontendPackage, /openai|anthropic|langchain|dialogflow/i)
        assert.doesNotMatch(chatbotSource, /dangerouslySetInnerHTML/)
    })
})
