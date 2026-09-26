/**
 * Packet ID tables for protocol 774 (Minecraft Java 1.21.11).
 *
 * Derived from the live server's status response (version "1.21.11",
 * protocol 774) and cross-checked against PrismarineJS minecraft-data's
 * 1.21.11 protocol.json plus MCProtocolLib packet layouts.
 *
 * Each array is indexed by packet ID: NAMES[id] -> packet name. When the
 * server version is configured to something else, `buildRegistry()` accepts
 * an override table so version handling stays configurable rather than
 * hard-coded (per the project requirements).
 */

export type ConnectionPhase =
  | "handshake"
  | "status"
  | "login"
  | "configuration"
  | "play";

export interface ProtocolRegistry {
  /** Protocol number sent in the handshake (e.g. 774). */
  protocolVersion: number;
  /** Human readable version (e.g. "1.21.11"). */
  versionName: string;
  handshake: Record<number, string>;
  status: { toClient: string[]; toServer: string[] };
  login: { toClient: string[]; toServer: string[] };
  configuration: { toClient: string[]; toServer: string[] };
  play: { toClient: string[]; toServer: string[] };
  /** name -> id lookup for a given phase/direction. */
  idFor(phase: ConnectionPhase, direction: "toClient" | "toServer", name: string): number | null;
  /** id -> name lookup; returns null when unknown. */
  nameFor(phase: ConnectionPhase, direction: "toClient" | "toServer", id: number): string | null;
}

const HANDSHAKE: Record<number, string> = {
  0x00: "set_protocol",
  0xfe: "legacy_server_list_ping",
};

const STATUS_TO_CLIENT = ["server_info", "ping"];
const STATUS_TO_SERVER = ["ping_start", "ping"];

const LOGIN_TO_CLIENT = [
  "disconnect",
  "encryption_begin",
  "success",
  "compress",
  "login_plugin_request",
  "cookie_request",
];
const LOGIN_TO_SERVER = [
  "login_start",
  "encryption_begin",
  "login_plugin_response",
  "login_acknowledged",
  "cookie_response",
];

const CONFIGURATION_TO_CLIENT = [
  "cookie_request",
  "custom_payload",
  "disconnect",
  "finish_configuration",
  "keep_alive",
  "ping",
  "reset_chat",
  "registry_data",
  "remove_resource_pack",
  "add_resource_pack",
  "store_cookie",
  "transfer",
  "feature_flags",
  "tags",
  "select_known_packs",
  "custom_report_details",
  "server_links",
  "clear_dialog",
  "show_dialog",
  "code_of_conduct",
];
const CONFIGURATION_TO_SERVER = [
  "settings",
  "cookie_response",
  "custom_payload",
  "finish_configuration",
  "keep_alive",
  "pong",
  "resource_pack_receive",
  "select_known_packs",
  "custom_click_action",
  "accept_code_of_conduct",
];

const PLAY_TO_CLIENT = [
  "bundle_delimiter",
  "spawn_entity",
  "animation",
  "statistics",
  "acknowledge_player_digging",
  "block_break_animation",
  "tile_entity_data",
  "block_action",
  "block_change",
  "boss_bar",
  "difficulty",
  "chunk_batch_finished",
  "chunk_batch_start",
  "chunk_biomes",
  "clear_titles",
  "tab_complete",
  "declare_commands",
  "close_window",
  "window_items",
  "craft_progress_bar",
  "set_slot",
  "cookie_request",
  "set_cooldown",
  "chat_suggestions",
  "custom_payload",
  "damage_event",
  "debug_block_value",
  "debug_chunk_value",
  "debug_entity_value",
  "debug_event",
  "debug_sample",
  "hide_message",
  "kick_disconnect",
  "profileless_chat",
  "entity_status",
  "sync_entity_position",
  "explosion",
  "unload_chunk",
  "game_state_change",
  "game_test_highlight_pos",
  "open_horse_window",
  "hurt_animation",
  "initialize_world_border",
  "keep_alive",
  "map_chunk",
  "world_event",
  "world_particles",
  "update_light",
  "login",
  "map",
  "trade_list",
  "rel_entity_move",
  "entity_move_look",
  "move_minecart",
  "entity_look",
  "vehicle_move",
  "open_book",
  "open_window",
  "open_sign_entity",
  "ping",
  "ping_response",
  "craft_recipe_response",
  "abilities",
  "player_chat",
  "end_combat_event",
  "enter_combat_event",
  "death_combat_event",
  "player_remove",
  "player_info",
  "face_player",
  "position",
  "player_rotation",
  "recipe_book_add",
  "recipe_book_remove",
  "recipe_book_settings",
  "entity_destroy",
  "remove_entity_effect",
  "reset_score",
  "remove_resource_pack",
  "add_resource_pack",
  "respawn",
  "entity_head_rotation",
  "multi_block_change",
  "select_advancement_tab",
  "server_data",
  "action_bar",
  "world_border_center",
  "world_border_lerp_size",
  "world_border_size",
  "world_border_warning_delay",
  "world_border_warning_reach",
  "camera",
  "update_view_position",
  "update_view_distance",
  "set_cursor_item",
  "spawn_position",
  "scoreboard_display_objective",
  "entity_metadata",
  "attach_entity",
  "entity_velocity",
  "entity_equipment",
  "experience",
  "update_health",
  "held_item_slot",
  "scoreboard_objective",
  "set_passengers",
  "set_player_inventory",
  "teams",
  "scoreboard_score",
  "simulation_distance",
  "set_title_subtitle",
  "update_time",
  "set_title_text",
  "set_title_time",
  "entity_sound_effect",
  "sound_effect",
  "start_configuration",
  "stop_sound",
  "store_cookie",
  "system_chat",
  "playerlist_header",
  "nbt_query_response",
  "collect",
  "entity_teleport",
  "test_instance_block_status",
  "set_ticking_state",
  "step_tick",
  "transfer",
  "advancements",
  "entity_update_attributes",
  "entity_effect",
  "declare_recipes",
  "tags",
  "set_projectile_power",
  "custom_report_details",
  "server_links",
  "tracked_waypoint",
  "clear_dialog",
  "show_dialog",
];

const PLAY_TO_SERVER = [
  "teleport_confirm",
  "query_block_nbt",
  "select_bundle_item",
  "set_difficulty",
  "change_gamemode",
  "message_acknowledgement",
  "chat_command",
  "chat_command_signed",
  "chat_message",
  "chat_session_update",
  "chunk_batch_received",
  "client_command",
  "tick_end",
  "settings",
  "tab_complete",
  "configuration_acknowledged",
  "enchant_item",
  "window_click",
  "close_window",
  "set_slot_state",
  "cookie_response",
  "custom_payload",
  "debug_subscription_request",
  "edit_book",
  "query_entity_nbt",
  "use_entity",
  "generate_structure",
  "keep_alive",
  "lock_difficulty",
  "position",
  "position_look",
  "look",
  "flying",
  "vehicle_move",
  "steer_boat",
  "pick_item_from_block",
  "pick_item_from_entity",
  "ping_request",
  "craft_recipe_request",
  "abilities",
  "block_dig",
  "entity_action",
  "player_input",
  "player_loaded",
  "pong",
  "recipe_book",
  "displayed_recipe",
  "name_item",
  "resource_pack_receive",
  "advancement_tab",
  "select_trade",
  "set_beacon_effect",
  "held_item_slot",
  "update_command_block",
  "update_command_block_minecart",
  "set_creative_slot",
  "update_jigsaw_block",
  "update_structure_block",
  "set_test_block",
  "update_sign",
  "arm_animation",
  "spectate",
  "test_instance_block_action",
  "block_place",
  "use_item",
  "custom_click_action",
];

/** Default registry for protocol 774 (Minecraft Java 1.21.11). */
export const REGISTRY_774: ProtocolRegistry = {
  protocolVersion: 774,
  versionName: "1.21.11",
  handshake: HANDSHAKE,
  status: { toClient: STATUS_TO_CLIENT, toServer: STATUS_TO_SERVER },
  login: { toClient: LOGIN_TO_CLIENT, toServer: LOGIN_TO_SERVER },
  configuration: {
    toClient: CONFIGURATION_TO_CLIENT,
    toServer: CONFIGURATION_TO_SERVER,
  },
  play: { toClient: PLAY_TO_CLIENT, toServer: PLAY_TO_SERVER },
  idFor(phase, direction, name) {
    if (phase === "handshake") {
      const entry = Object.entries(this.handshake).find(([, n]) => n === name);
      return entry ? Number(entry[0]) : null;
    }
    const table = tableFor(this, phase, direction);
    if (!table) return null;
    const idx = table.indexOf(name);
    return idx >= 0 ? idx : null;
  },
  nameFor(phase, direction, id) {
    if (phase === "handshake") return this.handshake[id] ?? null;
    const table = tableFor(this, phase, direction);
    if (!table) return null;
    return table[id] ?? null;
  },
};

function tableFor(
  registry: ProtocolRegistry,
  phase: ConnectionPhase,
  direction: "toClient" | "toServer",
): string[] | null {
  switch (phase) {
    case "status":
      return direction === "toClient" ? registry.status.toClient : registry.status.toServer;
    case "login":
      return direction === "toClient" ? registry.login.toClient : registry.login.toServer;
    case "configuration":
      return direction === "toClient"
        ? registry.configuration.toClient
        : registry.configuration.toServer;
    case "play":
      return direction === "toClient" ? registry.play.toClient : registry.play.toServer;
    case "handshake":
      return null;
    default:
      return null;
  }
}

/**
 * Look up the packet ID for an outbound packet, tolerating unknown names so
 * a mismatched registry produces a diagnosable error instead of a silent no-op.
 */
export function requirePacketId(
  registry: ProtocolRegistry,
  phase: ConnectionPhase,
  direction: "toClient" | "toServer",
  name: string,
): number {
  const id = registry.idFor(phase, direction, name);
  if (id === null) {
    throw new Error(
      `Packet "${name}" is not defined for ${phase}.${direction} in protocol ${registry.protocolVersion}`,
    );
  }
  return id;
}
