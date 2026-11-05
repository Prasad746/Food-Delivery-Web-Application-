import { createSlice } from "@reduxjs/toolkit";

const mapSlice=createSlice({
    name:"map",
    initialState:{
       location:{
        lat:null,
        lon:null
       },
       address:null

    },
    reducers:{
       setLocation:(state,action)=>{
        const {lat,lon}=action.payload
        state.location.lat=lat
        state.location.lon=lon
       },
        setAddress:(state,action)=>{
        state.address=action.payload
        },
        clearMapSessionState:(state)=>{
        state.location.lat=null
        state.location.lon=null
        state.address=null
        }
    }
})

export const {setAddress,setLocation,clearMapSessionState}=mapSlice.actions
export default mapSlice.reducer