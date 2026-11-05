export const DEFAULT_QUICK_REPLIES = Object.freeze([
    "Where is my latest order?",
    "What payment methods are available?",
    "What is the cancellation policy?",
    "How do I track my order?"
])

export const ORDER_QUICK_REPLIES = Object.freeze([
    "What is my payment status?",
    "What is the cancellation policy?",
    "How do I track my order?"
])

export const PAYMENT_QUICK_REPLIES = Object.freeze([
    "Where is my latest order?",
    "How does online payment work?",
    "What is the cancellation policy?"
])

export const CANCELLATION_QUICK_REPLIES = Object.freeze([
    "Where is my latest order?",
    "What is my payment status?",
    "How do I track my order?"
])

const homeLink = { label: "Browse food", path: "/" }
const cartLink = { label: "Open cart", path: "/cart" }
const ordersLink = { label: "My Orders", path: "/my-orders" }

export const SUPPORT_FAQS = Object.freeze([
    {
        intent: "faq_cod",
        keywords: ["cash on delivery", "cash-on-delivery", "cod", "pay at delivery", "pay when food arrives"],
        reply: "Cash on Delivery is available. Choose Cash On Delivery at checkout and pay when your food arrives. Vingo does not mark a COD order as a prepaid online payment.",
        links: [homeLink],
        quickReplies: DEFAULT_QUICK_REPLIES
    },
    {
        intent: "faq_online_payment",
        keywords: ["online payment", "online pay", "razorpay", "pay online", "digital payment"],
        reply: "Choose Online payment at checkout to pay through Razorpay. Vingo verifies the payment signature, order, amount, currency, and captured status on the backend before marking the order paid. If verification does not complete, the payment record is not marked successful.",
        links: [homeLink],
        quickReplies: DEFAULT_QUICK_REPLIES
    },
    {
        intent: "faq_payment_methods",
        keywords: ["payment methods", "payment method", "payment options", "how can i pay", "how do i pay", "ways to pay"],
        reply: "Vingo supports Cash on Delivery and online payment through Razorpay. You choose the method at checkout. Only Cash on Delivery and online payment are implemented in the current app.",
        links: [homeLink, ordersLink],
        quickReplies: DEFAULT_QUICK_REPLIES
    },
    {
        intent: "faq_place_order",
        keywords: ["place an order", "place order", "how to order", "how do i order", "proceed to checkout", "checkout", "check out", "buy food"],
        reply: "To place an order, browse food on the Home dashboard, set a quantity, and add items to your cart. Open the cart, review the total, and select Proceed to CheckOut. At checkout, set the delivery address, choose Cash on Delivery or Online payment, then place the order. You can follow it in My Orders.",
        links: [homeLink, cartLink, ordersLink],
        quickReplies: DEFAULT_QUICK_REPLIES
    },
    {
        intent: "faq_delivery_address",
        keywords: ["delivery address", "change my address", "change address", "edit address", "update address", "wrong address", "address at checkout", "saved address"],
        reply: "Enter or search for your delivery address on the checkout page and confirm the map location before placing the order. The order keeps the address used when it was placed. Vingo does not provide an order-editing flow or a saved-address book, so check My Orders for the current order status if an address may be wrong.",
        links: [cartLink, ordersLink],
        quickReplies: DEFAULT_QUICK_REPLIES
    },
    {
        intent: "faq_cart",
        keywords: ["add to cart", "add items", "add item", "remove item", "remove from cart", "cart quantity", "my cart", "cart"],
        reply: "To add food, use the + button on a food card to set a quantity, then press the cart button on that card. Open the cart from the header to change quantities with +/-. Use the trash button to remove an item, and select Proceed to CheckOut when ready.",
        links: [homeLink, cartLink],
        quickReplies: DEFAULT_QUICK_REPLIES
    },
    {
        intent: "faq_delivery",
        keywords: ["delivery process", "delivery fee", "delivery charge", "delivery cost", "delivery time", "how long delivery", "how long does delivery", "delivery partner", "delivery work"],
        reply: "Restaurant parts move through pending, preparing, out of delivery, and delivered; delivery is completed through the existing delivery OTP flow. Track Order shows each restaurant's status and live rider tracking when a delivery partner is assigned. The delivery fee is ₹40 when the food subtotal is ₹500 or less and free when the subtotal is above ₹500. The app does not show a guaranteed delivery-time estimate.",
        links: [ordersLink],
        quickReplies: DEFAULT_QUICK_REPLIES
    },
    {
        intent: "faq_account",
        keywords: ["account", "profile", "change name", "change email", "change mobile", "forgot password", "reset password", "password", "log out", "logout"],
        reply: "The account menu at the top-right shows your signed-in name and the Log Out action. To reset your password, log out and use Forgot Password on the sign-in page. The current app does not provide a profile page for changing your name, email, or mobile number.",
        links: [],
        quickReplies: DEFAULT_QUICK_REPLIES
    },
    {
        intent: "faq_restaurant",
        keywords: ["restaurant", "restaurants", "shop information", "shop info", "menu", "opening hours", "open hours", "restaurant address"],
        reply: "Restaurant cards on the Home dashboard show shops in your current city. Selecting a restaurant opens its menu with the shop name, address, and available dishes. Vingo does not display restaurant opening hours or a separate restaurant-rating page.",
        links: [homeLink],
        quickReplies: DEFAULT_QUICK_REPLIES
    },
    {
        intent: "faq_navigation",
        keywords: ["use the website", "use vingo", "navigate", "navigation", "find food", "find restaurants", "search restaurants", "search food", "where do i find", "website work"],
        reply: "From Home, use the header search for dishes in your current city, category cards to filter food, and restaurant cards to open a shop menu. The header cart opens /cart, My Orders opens /my-orders, and Track Order is available inside My Orders. The avatar at the top-right opens the account menu.",
        links: [homeLink, cartLink, ordersLink],
        quickReplies: DEFAULT_QUICK_REPLIES
    }
])
