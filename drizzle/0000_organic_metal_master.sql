CREATE TABLE `multiplayer_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`room_id` text NOT NULL,
	`target_player_id` text NOT NULL,
	`payload_json` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `multiplayer_rooms` (
	`room_id` text PRIMARY KEY NOT NULL,
	`host_id` text NOT NULL,
	`max_players` integer DEFAULT 2 NOT NULL,
	`status` text DEFAULT 'waiting' NOT NULL,
	`state_json` text NOT NULL,
	`updated_at` integer NOT NULL
);
