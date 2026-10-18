-- Create a two-track DI -> Element FX starting point in the current REAPER project.
-- Run via Actions > Show action list > ReaScript: Load, then run this action.
-- Element FX must already be installed as a CLAP plug-in and scanned by REAPER.
-- This creates a host shell; load and wire the desired effects inside Element.

local r = reaper
local function named(track, name)
  r.GetSetMediaTrackInfo_String(track, "P_NAME", name, true)
end

r.Undo_BeginBlock()
local start = r.CountTracks(0)
r.InsertTrackAtIndex(start, true)
local input = r.GetTrack(0, start)
named(input, "Guitar DI")

r.InsertTrackAtIndex(start + 1, true)
local rig = r.GetTrack(0, start + 1)
named(rig, "Rig / Element")

local fx = r.TrackFX_AddByName(rig, "Element FX", false, -1)
if fx < 0 then
  r.DeleteTrack(rig)
  r.DeleteTrack(input)
  r.Undo_EndBlock("Element FX unavailable; no rig created", -1)
  r.MB("REAPER could not add Element FX. Confirm the CLAP plug-in is installed, re-scan CLAP paths, then run this action again.", "Element rig", 0)
  return
end

local send = r.CreateTrackSend(input, rig)
if send < 0 then
  r.DeleteTrack(rig)
  r.DeleteTrack(input)
  r.Undo_EndBlock("Element rig routing failed; no rig created", -1)
  r.MB("REAPER could not route the DI track to Element.", "Element rig", 0)
  return
end
r.SetMediaTrackInfo_Value(input, "B_MAINSEND", 0)
r.SetOnlyTrackSelected(rig)
r.TrackFX_Show(rig, fx, 3)
r.TrackList_AdjustWindows(false)
r.UpdateArrange()
r.Undo_EndBlock("Create DI to Element rig", -1)
