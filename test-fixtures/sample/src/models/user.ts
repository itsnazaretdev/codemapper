import { Entity, Named, Role } from "./base.js";
import * as base from "./base";
export class User extends Entity<User> implements Named, base.Named { name = ""; role: Role = Role.User; validate() { return true; } async greet(): Promise<Map<string, number[]>> { return new Map(); } }
