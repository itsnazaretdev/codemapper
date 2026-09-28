import W from "../models/base";
import { User as U } from "../models";
import { User } from "../models/user";
export class UserService { constructor(private readonly weird: W, public count: number) {} find(): U | undefined { return new User(); } }
export const helper = () => 1;
function x() {} function x() {}
