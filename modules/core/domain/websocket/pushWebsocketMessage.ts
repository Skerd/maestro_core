import {WebSocketMessage} from "armonia/src/modules/core/websocket/types";
import {WebSocket} from "ws";
import {WebSocketServerLocal} from "@coreModule/connections/connectToWebSocketServer";

export function pushWebsocketMessage<T>(websocketMessage: WebSocketMessage<T>) {
    if (!!WebSocketServerLocal && WebSocketServerLocal.readyState === WebSocket.OPEN) {
        WebSocketServerLocal.send(JSON.stringify(websocketMessage));
    }
}