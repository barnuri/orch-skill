import { createContext, useContext } from "react";
import type { NodeMarker } from "../lib/node-markers";

const EMPTY: ReadonlyMap<string, NodeMarker[]> = new Map();

/** Markers per node id for the run on screen, so the graph card and the table row need no prop drilling. */
export const NodeMarkerContext = createContext<ReadonlyMap<string, NodeMarker[]>>(EMPTY);

export const useNodeMarkers = (id: string): readonly NodeMarker[] => useContext(NodeMarkerContext).get(id) ?? [];
