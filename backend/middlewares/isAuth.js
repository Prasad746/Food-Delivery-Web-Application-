import jwt from "jsonwebtoken"
import { isCurrentAuthVersion } from "../utils/authVersion.js"
import { isSessionTokenRevoked } from "../utils/sessionRevocation.js"
import { getJwtSecret } from "../config/security.js"
const isAuth=async (req,res,next) => {
    try {
        const token=req.cookies?.token || req.headers?.authorization?.replace(/^Bearer\s+/, "")
        if(!token){
            return res.status(401).json({message:"Authentication token required"})
        }
        const decodeToken=jwt.verify(token,getJwtSecret())
        if(!decodeToken || !decodeToken.userId){
            return res.status(401).json({message:"Invalid token payload"})
        }
        if(!(await isCurrentAuthVersion(decodeToken.userId, decodeToken.authVersion))){
            return res.status(401).json({message:"Invalid or expired token"})
        }
        if(await isSessionTokenRevoked(token)){
            return res.status(401).json({message:"Invalid or expired token"})
        }
        req.userId=decodeToken.userId
        next()
    } catch (error) {
         return res.status(401).json({message:"Invalid or expired token"})
    }
}

export default isAuth