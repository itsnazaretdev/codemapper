export abstract class Entity<T> { protected id: string = ""; abstract validate(): boolean; static create(): void {} }
export interface Named { name: string; greet(): Promise<Map<string, number[]>>; }
export default class Weird { cb: (a: number) => void = () => {}; obj: { a: 1 } = { a: 1 }; #secret = 1; "quoted-name" = 2; }
export enum Role { Admin, User }
