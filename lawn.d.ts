/// <reference path="defs/socket.io.extension.d.ts" />
/// <reference path="defs/express.d.ts" />
/// <reference path="lib/references.d.ts" />
declare class Lawn extends Vineyard.Bulb {
    public io: any;
    public instance_sockets: {};
    public instance_user_sockets: {};
    public app: any;
    public fs: any;
    public config: Lawn.Config;
    public redis_client: any;
    public http: any;
    public debug_mode: boolean;
    public grow(): void;
    static authorization(handshakeData: any, callback: any): any;
    public debug(...args: any[]): void;
    public emit_to_users(users: any, name: any, data: any): Promise;
    public notify(users: any, name: any, data: any, trellis_name: string): Promise;
    public get_user_sockets(id: number): Socket[];
    public initialize_session(socket: any, user: any): void;
    public query_user(user: any, query: Ground.Query_Builder): void;
    public start(): Promise;
    static public_user_properties: string[];
    static internal_user_properties: string[];
    private static is_ready_user_object(user);
    private static format_public_user(user);
    private static format_internal_user(user);
    public get_public_user(user: any): Promise;
    public get_schema(req: any, res: any, user: any): void;
    public get_user_from_session(token: string): Promise;
    public http_login(req: any, res: any, body: any): Promise;
    static create_session(user: any, req: any, ground: any): Promise;
    public send_http_login_success(req: any, res: any, user: any): void;
    public register(req: any, res: any): Promise;
    public link_facebook_user(req: any, res: any, user: any): Promise;
    static request(options: any, data?: any, secure?: boolean): Promise;
    public login(data: any, socket: ISocket, callback: any): void;
    public on_connection(socket: ISocket): Socket;
    static process_public_http(req: any, res: any, action: any): void;
    public on_socket(socket: any, event: any, user: any, action: any): void;
    static listen_public_http(app: any, path: any, action: any, method?: string): void;
    public listen_public_http(path: any, action: any, method?: string): void;
    public process_error(error: any, user: any): {
        status: any;
        message: any;
    };
    public process_user_http(req: any, res: any, action: any): void;
    public listen_user_http(path: any, action: any, method?: string): void;
    public start_sockets(port?: any): void;
    public file_download(req: any, res: any, user: any): Promise;
    private static file_exists(filepath);
    public start_http(port: any): void;
    public stop(): void;
}
declare module Lawn {
    interface Session_Store_DB {
        host: string;
        port: number;
        user: string;
        password: string;
        database: string;
    }
    interface Session_Store_Config {
        key: string;
        secret: string;
        db: Session_Store_DB;
    }
    interface Config {
        ports: any;
        log_updates?: boolean;
        use_redis?: boolean;
        cookie_secret?: string;
        log_file?: string;
        admin: any;
        file_path?: string;
        mysql_session_store?: Session_Store_Config;
    }
    interface Update_Request {
        objects: any[];
    }
    class HttpError {
        public name: string;
        public message: any;
        public stack: any;
        public status: any;
        public details: any;
        constructor(message: string, status?: number);
    }
    class Authorization_Error extends HttpError {
        public details: any;
        constructor(message: string, details: any);
    }
    class Irrigation {
        static process(method: string, request: Ground.External_Query_Source, user: Vineyard.IUser, vineyard: Vineyard, socket: any, callback: any): Promise;
        static query(request: Ground.External_Query_Source, user: Vineyard.IUser, ground: Ground.Core, vineyard: Vineyard): Promise;
        static update(request: Update_Request, user: Vineyard.IUser, ground: Ground.Core, vineyard: Vineyard): Promise;
    }
    class Facebook extends Vineyard.Bulb {
        public lawn: Lawn;
        public grow(): void;
        public create_user(facebook_id: any, source: any): Promise;
        public login(req: any, res: any, body: any): Promise;
        public get_user(body: any): Promise;
        public get_user_facebook_id(body: any): Promise;
    }
    class Songbird extends Vineyard.Bulb {
        public lawn: Lawn;
        public grow(): void;
        public initialize_socket(socket: any, user: any): void;
        public notify(users: any, name: any, data: any, trellis_name: string, store?: boolean): Promise;
        public notification_receieved(user: any, request: any): Promise;
        public send_pending_notifications(user: any): void;
    }
}
declare module "vineyard-lawn" { export = Lawn }
