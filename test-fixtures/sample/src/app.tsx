import { UserService } from "./services/userService";
export class App { svc = new UserService(null as any, 1); render() { return <div className="a">{this.svc.find()?.name}</div>; } }
class App {}
