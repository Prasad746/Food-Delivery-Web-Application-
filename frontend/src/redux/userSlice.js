import { createSlice } from "@reduxjs/toolkit";
import { normalizeMoney } from "../utils/discountPricing.js";

const MAX_ITEM_QUANTITY = 99

const sameId = (left, right) => String(left) === String(right)

const clampQuantity = (value) =>
  Math.min(MAX_ITEM_QUANTITY, Math.max(1, Math.floor(Number(value) || 0)))

const cartTotal = (items) =>
  normalizeMoney(items.reduce((sum, item) => sum + normalizeMoney(item.price) * (Number(item.quantity) || 0), 0))

const shopOrdersOf = (order) => {
  if (Array.isArray(order?.shopOrders)) {
    return order.shopOrders
  }
  return order?.shopOrders ? [order.shopOrders] : []
}

const applyShopOrderUpdate = (order, shopId, updates) => {
  for (const shopOrder of shopOrdersOf(order)) {
    const id = shopOrder?.shop?._id ?? shopOrder?.shop
    if (id !== undefined && sameId(id, shopId)) {
      Object.assign(shopOrder, updates)
    }
  }
}

const userSlice = createSlice({
  name: "user",
  initialState: {
    userData: null,
    currentCity: null,
    currentCitySource: null,
    currentState: null,
    currentAddress: null,
    shopInMyCity: null,
    itemsInMyCity: null,
    cartItems: [],
    totalAmount: 0,
    myOrders: [],
    searchItems: null,
    deliveryBoyLocation: null,
    deliveryBoyTrackingStatus: null
  },
  reducers: {
    setUserData: (state, action) => {
      state.userData = action.payload
    },
    setCurrentCity: (state, action) => {
      state.currentCity = action.payload
    },
    setCurrentCitySource: (state, action) => {
      state.currentCitySource = action.payload
    },
    setManualCurrentCity: (state, action) => {
      const { city = null, state: region = null, address = null } = action.payload || {}
      state.currentCity = city
      state.currentState = region
      state.currentAddress = address
      state.currentCitySource = city ? "manual" : null
    },
    clearCurrentCitySelection: (state) => {
      state.currentCity = null
      state.currentState = null
      state.currentAddress = null
      state.currentCitySource = null
    },
    setCurrentState: (state, action) => {
      state.currentState = action.payload
    },
    setCurrentAddress: (state, action) => {
      state.currentAddress = action.payload
    },
    setShopsInMyCity: (state, action) => {
      state.shopInMyCity = action.payload
    },
    setItemsInMyCity: (state, action) => {
      state.itemsInMyCity = action.payload
    },
    addToCart: (state, action) => {
      const cartItem = action.payload
      const requestedQuantity = Math.floor(Number(cartItem.quantity) || 0)
      if (!cartItem.id || !cartItem.shop || requestedQuantity <= 0) {
        return
      }
      const quantity = clampQuantity(requestedQuantity)
      const existingItem = state.cartItems.find(i => i.id == cartItem.id)
      if (existingItem) {
        existingItem.quantity = clampQuantity(existingItem.quantity + quantity)
        Object.assign(existingItem, cartItem, { quantity: existingItem.quantity })
      } else {
        state.cartItems.push({ ...cartItem, quantity })
      }

      state.totalAmount = cartTotal(state.cartItems)

    },
 
    setTotalAmount: (state, action) => {
      state.totalAmount = action.payload
    }

    ,

    updateQuantity: (state, action) => {
      const { id, quantity } = action.payload
      const item = state.cartItems.find(i => i.id == id)
      if (item) {
        item.quantity = clampQuantity(quantity)
      }
      state.totalAmount = cartTotal(state.cartItems)
    },

    syncCartItems: (state, action) => {
      for (const update of action.payload || []) {
        const item = state.cartItems.find(i => i.id == update.id)
        if (item) {
          const quantity = item.quantity
          Object.assign(item, update, { quantity })
        }
      }
      state.totalAmount = cartTotal(state.cartItems)
    },

    removeCartItem: (state, action) => {
      state.cartItems = state.cartItems.filter(i => i.id !== action.payload)
      state.totalAmount = cartTotal(state.cartItems)
    },

    setMyOrders: (state, action) => {
      state.myOrders = action.payload
    },
    addMyOrder: (state, action) => {
      state.myOrders = [action.payload, ...state.myOrders]
    }

    ,
    updateOrderStatus: (state, action) => {
      const { orderId, shopId, status, refund, cancelledAt, cancellationReason } = action.payload
      const order = state.myOrders.find(o => o._id == orderId)
      if (order) {
        applyShopOrderUpdate(order, shopId, {
          status,
          ...(refund !== undefined ? { refund } : {}),
          ...(cancelledAt !== undefined ? { cancelledAt } : {}),
          ...(cancellationReason !== undefined ? { cancellationReason } : {})
        })
      }
    },
 
    updateRealtimeOrderStatus: (state, action) => {
      const { orderId, shopId, status, refund, cancelledAt, cancellationReason } = action.payload
      const order = state.myOrders.find(o => o._id == orderId)
      if (order) {
        applyShopOrderUpdate(order, shopId, {
          status,
          ...(refund !== undefined ? { refund } : {}),
          ...(cancelledAt !== undefined ? { cancelledAt } : {}),
          ...(cancellationReason !== undefined ? { cancellationReason } : {})
        })
      }
    },

    setSearchItems: (state, action) => {
      state.searchItems = action.payload
    },

    setDeliveryBoyLocation: (state, action) => {
      state.deliveryBoyLocation = action.payload
    },
    setDeliveryBoyTrackingStatus: (state, action) => {
      state.deliveryBoyTrackingStatus = action.payload
    },
    clearSessionState: (state) => {
      state.userData = null
      state.currentCity = null
      state.currentCitySource = null
      state.currentState = null
      state.currentAddress = null
      state.shopInMyCity = null
      state.itemsInMyCity = null
      state.cartItems = []
      state.totalAmount = 0
      state.myOrders = []
      state.searchItems = null
      state.deliveryBoyLocation = null
      state.deliveryBoyTrackingStatus = null
    }
  }
})

export const { setUserData, setCurrentAddress, setCurrentCity, setCurrentCitySource, setManualCurrentCity, clearCurrentCitySelection, setCurrentState, setShopsInMyCity, setItemsInMyCity, addToCart, updateQuantity, syncCartItems, removeCartItem, setMyOrders, addMyOrder, updateOrderStatus, setSearchItems, setTotalAmount, setDeliveryBoyLocation, setDeliveryBoyTrackingStatus, updateRealtimeOrderStatus, clearSessionState} = userSlice.actions
export default userSlice.reducer