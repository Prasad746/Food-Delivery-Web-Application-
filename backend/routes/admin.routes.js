import { Router } from "express"
import isAuth from "../middlewares/isAuth.js"
import { isAdmin } from "../middlewares/isAdmin.js"
import { getAdminSummary } from "../controllers/admin.controllers.js"

const router = Router()

router.get("/summary", isAuth, isAdmin, getAdminSummary)

export default router
