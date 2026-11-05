import React, { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
    FaArrowRight,
    FaCommentDots,
    FaPaperPlane,
    FaRedo,
    FaTimes,
    FaTrashAlt
} from 'react-icons/fa'
import api from '../utils/axiosInstance'

const MAX_MESSAGE_LENGTH = 500

const DEFAULT_QUICK_REPLIES = [
    'Where is my latest order?',
    'What payment methods are available?',
    'What is the cancellation policy?',
    'How do I track my order?'
]

const createWelcomeMessage = () => ({
    id: 'welcome',
    role: 'assistant',
    text: "Hi! I'm Vingo Support. I can help with order status, tracking, cancellations, payments, delivery fees, your account, and finding your way around Vingo.",
    quickReplies: DEFAULT_QUICK_REPLIES,
    links: []
})

function SupportChatbot({ orderId = null }) {
    const [isOpen, setIsOpen] = useState(false)
    const [messages, setMessages] = useState(() => [createWelcomeMessage()])
    const [input, setInput] = useState('')
    const [isSending, setIsSending] = useState(false)
    const [error, setError] = useState(null)
    const messagesEndRef = useRef(null)
    const inputRef = useRef(null)
    const nextIdRef = useRef(1)
    const navigate = useNavigate()

    const nextMessageId = () => {
        nextIdRef.current += 1
        return `support-message-${nextIdRef.current}`
    }

    useEffect(() => {
        if (isOpen) {
            inputRef.current?.focus()
        }
    }, [isOpen])

    useEffect(() => {
        if (!isOpen) return
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
    }, [messages, isOpen, isSending, error])

    useEffect(() => {
        if (!isOpen) return undefined

        const handleKeyDown = (event) => {
            if (event.key === 'Escape') {
                setIsOpen(false)
            }
        }

        window.addEventListener('keydown', handleKeyDown)
        return () => window.removeEventListener('keydown', handleKeyDown)
    }, [isOpen])

    const sendMessage = async (rawText, { appendUserMessage = true } = {}) => {
        const text = String(rawText || '').trim()
        if (!text || isSending) return

        if (appendUserMessage) {
            setMessages((current) => [
                ...current,
                { id: nextMessageId(), role: 'user', text, quickReplies: [], links: [] }
            ])
        }

        setInput('')
        setError(null)
        setIsSending(true)

        try {
            const payload = { message: text }
            if (orderId) {
                payload.orderId = orderId
            }
            const result = await api.post('/api/support/chat', payload)
            const data = result?.data
            if (!data || typeof data.reply !== 'string' || !data.reply.trim()) {
                throw new Error('Invalid support response')
            }

            setMessages((current) => [
                ...current,
                {
                    id: nextMessageId(),
                    role: 'assistant',
                    text: data.reply,
                    quickReplies: Array.isArray(data.quickReplies) ? data.quickReplies : [],
                    links: Array.isArray(data.links) ? data.links : [],
                    intent: data.intent
                }
            ])
        } catch {
            setError({
                text: 'Support chat is unavailable right now. Please try again.',
                retryText: text
            })
        } finally {
            setIsSending(false)
        }
    }

    const handleSubmit = (event) => {
        event.preventDefault()
        void sendMessage(input)
    }

    const handleQuickReply = (reply) => {
        void sendMessage(reply)
    }

    const handleRetry = () => {
        if (!error?.retryText) return
        void sendMessage(error.retryText, { appendUserMessage: false })
    }

    const handleLink = (link) => {
        const path = String(link?.path || '')
        if (!path.startsWith('/') || path.startsWith('//')) return
        setIsOpen(false)
        navigate(path)
    }

    const clearConversation = () => {
        if (isSending) return
        setMessages([createWelcomeMessage()])
        setInput('')
        setError(null)
    }

    const lastMessage = messages[messages.length - 1]
    const quickReplies =
        !isSending && !error && lastMessage?.role === 'assistant'
            ? lastMessage.quickReplies || []
            : []

    return (
        <>
            {isOpen && (
                <section
                    className="fixed bottom-24 right-4 z-[80] flex h-[min(620px,calc(100vh-7rem))] w-[calc(100vw-2rem)] max-w-[400px] flex-col overflow-hidden rounded-3xl border border-orange-100 bg-white shadow-2xl sm:bottom-24 sm:right-6"
                    aria-label="Vingo customer support chat"
                >
                    <header className="flex items-center justify-between gap-3 bg-[#ff4d2d] px-4 py-3 text-white">
                        <div className="flex min-w-0 items-center gap-3">
                            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/20">
                                <FaCommentDots size={18} />
                            </div>
                            <div className="min-w-0">
                                <h2 className="truncate text-base font-semibold">Vingo Support</h2>
                                <p className="truncate text-xs text-orange-100">
                                    Order, payment, and app help
                                </p>
                            </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                            <button
                                type="button"
                                onClick={clearConversation}
                                disabled={isSending}
                                className="rounded-full p-2 text-white transition-colors hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-50"
                                aria-label="Clear conversation"
                                title="Clear conversation"
                            >
                                <FaTrashAlt size={14} />
                            </button>
                            <button
                                type="button"
                                onClick={() => setIsOpen(false)}
                                className="rounded-full p-2 text-white transition-colors hover:bg-white/15"
                                aria-label="Close support chat"
                                title="Close support chat"
                            >
                                <FaTimes size={16} />
                            </button>
                        </div>
                    </header>

                    <div
                        className="flex-1 space-y-3 overflow-y-auto bg-[#fff9f6] px-3 py-4"
                        aria-live="polite"
                        aria-busy={isSending}
                    >
                        {messages.map((message) => (
                            <div
                                key={message.id}
                                className={`flex ${
                                    message.role === 'user' ? 'justify-end' : 'justify-start'
                                }`}
                            >
                                <div
                                    className={`max-w-[88%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed shadow-sm ${
                                        message.role === 'user'
                                            ? 'rounded-br-md bg-[#ff4d2d] text-white'
                                            : 'rounded-bl-md border border-orange-100 bg-white text-gray-700'
                                    }`}
                                >
                                    <p className="whitespace-pre-wrap break-words">{message.text}</p>
                                    {message.role === 'assistant' && message.links?.length > 0 && (
                                        <div className="mt-3 flex flex-wrap gap-2">
                                            {message.links.map((link) => (
                                                <button
                                                    key={`${message.id}-${link.label}-${link.path}`}
                                                    type="button"
                                                    onClick={() => handleLink(link)}
                                                    className="inline-flex items-center gap-1.5 rounded-full border border-orange-200 bg-orange-50 px-3 py-1 text-xs font-semibold text-[#c43a22] transition-colors hover:bg-orange-100"
                                                >
                                                    {link.label}
                                                    <FaArrowRight size={10} />
                                                </button>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            </div>
                        ))}

                        {isSending && (
                            <div className="flex justify-start" role="status">
                                <div className="flex items-center gap-1.5 rounded-2xl rounded-bl-md border border-orange-100 bg-white px-4 py-3 text-gray-500 shadow-sm">
                                    <span className="sr-only">Vingo Support is typing</span>
                                    {[0, 1, 2].map((dot) => (
                                        <span
                                            key={dot}
                                            className="h-1.5 w-1.5 animate-bounce rounded-full bg-[#ff4d2d]"
                                            style={{ animationDelay: `${dot * 120}ms` }}
                                        />
                                    ))}
                                </div>
                            </div>
                        )}

                        {error && (
                            <div
                                className="rounded-2xl border border-red-100 bg-red-50 p-3 text-sm text-red-700"
                                role="alert"
                            >
                                <p>{error.text}</p>
                                <button
                                    type="button"
                                    onClick={handleRetry}
                                    disabled={isSending}
                                    className="mt-2 inline-flex items-center gap-2 rounded-full bg-white px-3 py-1.5 text-xs font-semibold text-red-700 shadow-sm transition-colors hover:bg-red-100 disabled:opacity-50"
                                >
                                    <FaRedo size={10} />
                                    Retry
                                </button>
                            </div>
                        )}

                        <div ref={messagesEndRef} />
                    </div>

                    {quickReplies.length > 0 && (
                        <div className="flex gap-2 overflow-x-auto border-t border-orange-100 bg-white px-3 py-2.5">
                            {quickReplies.map((reply) => (
                                <button
                                    key={reply}
                                    type="button"
                                    onClick={() => handleQuickReply(reply)}
                                    className="shrink-0 rounded-full border border-orange-200 bg-orange-50 px-3 py-1.5 text-xs font-medium text-[#c43a22] transition-colors hover:bg-orange-100"
                                >
                                    {reply}
                                </button>
                            ))}
                        </div>
                    )}

                    <form
                        onSubmit={handleSubmit}
                        className="flex items-center gap-2 border-t border-orange-100 bg-white p-3"
                    >
                        <label htmlFor="support-chat-input" className="sr-only">
                            Message Vingo Support
                        </label>
                        <input
                            id="support-chat-input"
                            ref={inputRef}
                            type="text"
                            value={input}
                            onChange={(event) => setInput(event.target.value)}
                            maxLength={MAX_MESSAGE_LENGTH}
                            placeholder="Ask about orders, payments, or the app"
                            disabled={isSending}
                            autoComplete="off"
                            className="min-w-0 flex-1 rounded-full border border-orange-200 bg-[#fff9f6] px-4 py-2.5 text-sm text-gray-800 outline-none transition focus:border-[#ff4d2d] focus:ring-2 focus:ring-orange-100 disabled:opacity-70"
                        />
                        <button
                            type="submit"
                            disabled={isSending || !input.trim()}
                            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#ff4d2d] text-white transition-colors hover:bg-[#e64528] disabled:cursor-not-allowed disabled:opacity-50"
                            aria-label="Send message"
                            title="Send message"
                        >
                            <FaPaperPlane size={14} />
                        </button>
                    </form>
                </section>
            )}

            <button
                type="button"
                onClick={() => setIsOpen((current) => !current)}
                className="fixed bottom-5 right-4 z-[80] flex h-14 w-14 items-center justify-center rounded-full bg-[#ff4d2d] text-white shadow-xl transition-colors hover:bg-[#e64528] sm:right-6"
                aria-label={isOpen ? 'Close support chat' : 'Open support chat'}
                title={isOpen ? 'Close support chat' : 'Open support chat'}
            >
                {isOpen ? <FaTimes size={20} /> : <FaCommentDots size={22} />}
            </button>
        </>
    )
}

export default SupportChatbot
