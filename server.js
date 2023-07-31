(function (global, factory) {
    typeof exports === 'object' && typeof module !== 'undefined' ? module.exports = factory(require('http'), require('fs'), require('crypto')) :
    typeof define === 'function' && define.amd ? define(['http', 'fs', 'crypto'], factory) :
    (global = typeof globalThis !== 'undefined' ? globalThis : global || self, global.Server = factory(global.http, global.fs, global.crypto));
}(this, (function (http, fs, crypto) { 'use strict';

    function _interopDefaultLegacy (e) { return e && typeof e === 'object' && 'default' in e ? e : { 'default': e }; }

    var http__default = /*#__PURE__*/_interopDefaultLegacy(http);
    var fs__default = /*#__PURE__*/_interopDefaultLegacy(fs);
    var crypto__default = /*#__PURE__*/_interopDefaultLegacy(crypto);

    class ServiceError extends Error {
        constructor(message = 'Service Error') {
            super(message);
            this.name = 'ServiceError'; 
        }
    }

    class NotFoundError extends ServiceError {
        constructor(message = 'Resource not found') {
            super(message);
            this.name = 'NotFoundError'; 
            this.status = 404;
        }
    }

    class RequestError extends ServiceError {
        constructor(message = 'Request error') {
            super(message);
            this.name = 'RequestError'; 
            this.status = 400;
        }
    }

    class ConflictError extends ServiceError {
        constructor(message = 'Resource conflict') {
            super(message);
            this.name = 'ConflictError'; 
            this.status = 409;
        }
    }

    class AuthorizationError extends ServiceError {
        constructor(message = 'Unauthorized') {
            super(message);
            this.name = 'AuthorizationError'; 
            this.status = 401;
        }
    }

    class CredentialError extends ServiceError {
        constructor(message = 'Forbidden') {
            super(message);
            this.name = 'CredentialError'; 
            this.status = 403;
        }
    }

    var errors = {
        ServiceError,
        NotFoundError,
        RequestError,
        ConflictError,
        AuthorizationError,
        CredentialError
    };

    const { ServiceError: ServiceError$1 } = errors;


    function createHandler(plugins, services) {
        return async function handler(req, res) {
            const method = req.method;
            console.info(`<< ${req.method} ${req.url}`);

            // Redirect fix for admin panel relative paths
            if (req.url.slice(-6) == '/admin') {
                res.writeHead(302, {
                    'Location': `http://${req.headers.host}/admin/`
                });
                return res.end();
            }

            let status = 200;
            let headers = {
                'Access-Control-Allow-Origin': '*',
                'Content-Type': 'application/json'
            };
            let result = '';
            let context;

            // NOTE: the OPTIONS method results in undefined result and also it never processes plugins - keep this in mind
            if (method == 'OPTIONS') {
                Object.assign(headers, {
                    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
                    'Access-Control-Allow-Credentials': false,
                    'Access-Control-Max-Age': '86400',
                    'Access-Control-Allow-Headers': 'X-Requested-With, X-HTTP-Method-Override, Content-Type, Accept, X-Authorization'
                });
            } else {
                try {
                    context = processPlugins();
                    await handle(context);
                } catch (err) {
                    if (err instanceof ServiceError$1) {
                        status = err.status || 400;
                        result = composeErrorObject(err.code || status, err.message);
                    } else {
                        // Unhandled exception, this is due to an error in the service code - REST consumers should never have to encounter this;
                        // If it happens, it must be debugged in a future version of the server
                        console.error(err);
                        status = 500;
                        result = composeErrorObject(500, 'Server Error');
                    }
                }
            }

            res.writeHead(status, headers);
            if (context != undefined && context.util != undefined && context.util.throttle) {
                await new Promise(r => setTimeout(r, 500 + Math.random() * 500));
            }
            res.end(result);

            function processPlugins() {
                const context = { params: {} };
                plugins.forEach(decorate => decorate(context, req));
                return context;
            }

            async function handle(context) {
                const { serviceName, tokens, query, body } = await parseRequest(req);
                if (serviceName == 'admin') {
                    return ({ headers, result } = services['admin'](method, tokens, query, body));
                } else if (serviceName == 'favicon.ico') {
                    return ({ headers, result } = services['favicon'](method, tokens, query, body));
                }

                const service = services[serviceName];

                if (service === undefined) {
                    status = 400;
                    result = composeErrorObject(400, `Service "${serviceName}" is not supported`);
                    console.error('Missing service ' + serviceName);
                } else {
                    result = await service(context, { method, tokens, query, body });
                }

                // NOTE: currently there is no scenario where result is undefined - it will either be data, or an error object;
                // this may change with further extension of the services, so this check should stay in place
                if (result !== undefined) {
                    result = JSON.stringify(result);
                }
            }
        };
    }



    function composeErrorObject(code, message) {
        return JSON.stringify({
            code,
            message
        });
    }

    async function parseRequest(req) {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const tokens = url.pathname.split('/').filter(x => x.length > 0);
        const serviceName = tokens.shift();
        const queryString = url.search.split('?')[1] || '';
        const query = queryString
            .split('&')
            .filter(s => s != '')
            .map(x => x.split('='))
            .reduce((p, [k, v]) => Object.assign(p, { [k]: decodeURIComponent(v) }), {});
        const body = await parseBody(req);

        return {
            serviceName,
            tokens,
            query,
            body
        };
    }

    function parseBody(req) {
        return new Promise((resolve, reject) => {
            let body = '';
            req.on('data', (chunk) => body += chunk.toString());
            req.on('end', () => {
                try {
                    resolve(JSON.parse(body));
                } catch (err) {
                    resolve(body);
                }
            });
        });
    }

    var requestHandler = createHandler;

    class Service {
        constructor() {
            this._actions = [];
            this.parseRequest = this.parseRequest.bind(this);
        }

        /**
         * Handle service request, after it has been processed by a request handler
         * @param {*} context Execution context, contains result of middleware processing
         * @param {{method: string, tokens: string[], query: *, body: *}} request Request parameters
         */
        async parseRequest(context, request) {
            for (let {method, name, handler} of this._actions) {
                if (method === request.method && matchAndAssignParams(context, request.tokens[0], name)) {
                    return await handler(context, request.tokens.slice(1), request.query, request.body);
                }
            }
        }

        /**
         * Register service action
         * @param {string} method HTTP method
         * @param {string} name Action name. Can be a glob pattern.
         * @param {(context, tokens: string[], query: *, body: *)} handler Request handler
         */
        registerAction(method, name, handler) {
            this._actions.push({method, name, handler});
        }

        /**
         * Register GET action
         * @param {string} name Action name. Can be a glob pattern.
         * @param {(context, tokens: string[], query: *, body: *)} handler Request handler
         */
        get(name, handler) {
            this.registerAction('GET', name, handler);
        }

        /**
         * Register POST action
         * @param {string} name Action name. Can be a glob pattern.
         * @param {(context, tokens: string[], query: *, body: *)} handler Request handler
         */
        post(name, handler) {
            this.registerAction('POST', name, handler);
        }

        /**
         * Register PUT action
         * @param {string} name Action name. Can be a glob pattern.
         * @param {(context, tokens: string[], query: *, body: *)} handler Request handler
         */
        put(name, handler) {
            this.registerAction('PUT', name, handler);
        }

        /**
         * Register DELETE action
         * @param {string} name Action name. Can be a glob pattern.
         * @param {(context, tokens: string[], query: *, body: *)} handler Request handler
         */
        delete(name, handler) {
            this.registerAction('DELETE', name, handler);
        }
    }

    function matchAndAssignParams(context, name, pattern) {
        if (pattern == '*') {
            return true;
        } else if (pattern[0] == ':') {
            context.params[pattern.slice(1)] = name;
            return true;
        } else if (name == pattern) {
            return true;
        } else {
            return false;
        }
    }

    var Service_1 = Service;

    function uuid() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
            let r = Math.random() * 16 | 0,
                v = c == 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }

    var util = {
        uuid
    };

    const uuid$1 = util.uuid;


    const data = fs__default['default'].readdirSync('./data').reduce((p, c) => {
        const content = JSON.parse(fs__default['default'].readFileSync('./data/' + c));
        const collection = c.slice(0, -5);
        p[collection] = {};
        for (let endpoint in content) {
            p[collection][endpoint] = content[endpoint];
        }
        return p;
    }, {});

    const actions = {
        get: (context, tokens, query, body) => {
            tokens = [context.params.collection, ...tokens];
            let responseData = data;
            for (let token of tokens) {
                if (responseData !== undefined) {
                    responseData = responseData[token];
                }
            }
            return responseData;
        },
        post: (context, tokens, query, body) => {
            tokens = [context.params.collection, ...tokens];
            console.log('Request body:\n', body);

            // TODO handle collisions, replacement
            let responseData = data;
            for (let token of tokens) {
                if (responseData.hasOwnProperty(token) == false) {
                    responseData[token] = {};
                }
                responseData = responseData[token];
            }

            const newId = uuid$1();
            responseData[newId] = Object.assign({}, body, { _id: newId });
            return responseData[newId];
        },
        put: (context, tokens, query, body) => {
            tokens = [context.params.collection, ...tokens];
            console.log('Request body:\n', body);

            let responseData = data;
            for (let token of tokens) {
                if (responseData !== undefined) {
                    responseData = responseData[token];
                }
            }
            if (responseData !== undefined) {
                Object.assign(responseData, body);
            }
            return responseData;
        },
        delete: (context, tokens, query, body) => {
            tokens = [context.params.collection, ...tokens];
            let responseData = data;

            for (let i = 0; i < tokens.length; i++) {
                const token = tokens[i];
                if (responseData.hasOwnProperty(token) == false) {
                    return null;
                }
                if (i == tokens.length - 1) {
                    const body = responseData[token];
                    delete responseData[token];
                    return body;
                } else {
                    responseData = responseData[token];
                }
            }
        }
    };

    const dataService = new Service_1();
    dataService.get(':collection', actions.get);
    dataService.post(':collection', actions.post);
    dataService.put(':collection', actions.put);
    dataService.delete(':collection', actions.delete);


    var jsonstore = dataService.parseRequest;

    /*
     * This service requires storage and auth plugins
     */

    const userService = new Service_1();

    userService.post('register', onRegister);
    userService.post('login', onLogin);
    userService.get('logout', onLogout);
    // TODO: get user details

    function onRegister(context, tokens, query, body) {
        return context.auth.register(body);
    }

    function onLogin(context, tokens, query, body) {
        return context.auth.login(body);
    }

    function onLogout(context, tokens, query, body) {
        return context.auth.logout();
    }

    var users = userService.parseRequest;

    /*
     * This service requires storage and auth plugins
     */

    const { NotFoundError: NotFoundError$1, RequestError: RequestError$1, CredentialError: CredentialError$1, AuthorizationError: AuthorizationError$1 } = errors;


    const dataService$1 = new Service_1();
    dataService$1.get(':collection', get);
    dataService$1.post(':collection', post);
    dataService$1.put(':collection', put);
    dataService$1.delete(':collection', del);

    function validateRequest(context, tokens, query) {
        /*
        if (context.params.collection == undefined) {
            throw new RequestError('Please, specify collection name');
        }
        */
        if (tokens.length > 1) {
            throw new RequestError$1();
        }
    }

    function parseWhere(query) {
        const operators = {
            '<=': (prop, value) => record => record[prop] <= JSON.parse(value),
            '<': (prop, value) => record => record[prop] < JSON.parse(value),
            '>=': (prop, value) => record => record[prop] >= JSON.parse(value),
            '>': (prop, value) => record => record[prop] > JSON.parse(value),
            '=': (prop, value) => record => record[prop] == JSON.parse(value),
            ' like ': (prop, value) => record => record[prop].toLowerCase().includes(JSON.parse(value).toLowerCase()),
            ' in ': (prop, value) => record => JSON.parse(`[${/\((.+?)\)/.exec(value)[1]}]`).includes(record[prop]),
        };
        const pattern = new RegExp(`^(.+?)(${Object.keys(operators).join('|')})(.+?)$`, 'i');

        try {
            let clauses = [query.trim()];
            let check = (a, b) => b;
            let acc = true;
            if (query.match(/ and /gi)) {
                // inclusive
                clauses = query.split(/ and /gi);
                check = (a, b) => a && b;
                acc = true;
            } else if (query.match(/ or /gi)) {
                // optional
                clauses = query.split(/ or /gi);
                check = (a, b) => a || b;
                acc = false;
            }
            clauses = clauses.map(createChecker);

            return (record) => clauses
                .map(c => c(record))
                .reduce(check, acc);
        } catch (err) {
            throw new Error('Could not parse WHERE clause, check your syntax.');
        }

        function createChecker(clause) {
            let [match, prop, operator, value] = pattern.exec(clause);
            [prop, value] = [prop.trim(), value.trim()];

            return operators[operator.toLowerCase()](prop, value);
        }
    }


    function get(context, tokens, query, body) {
        validateRequest(context, tokens);

        let responseData;

        try {
            if (query.where) {
                responseData = context.storage.get(context.params.collection).filter(parseWhere(query.where));
            } else if (context.params.collection) {
                responseData = context.storage.get(context.params.collection, tokens[0]);
            } else {
                // Get list of collections
                return context.storage.get();
            }

            if (query.distinct) {
                const props = query.distinct.split(',').filter(p => p != '');
                responseData = Object.values(responseData.reduce((distinct, c) => {
                    const key = props.map(p => c[p]).join('::');
                    if (distinct.hasOwnProperty(key) == false) {
                        distinct[key] = c;
                    }
                    return distinct;
                }, {}));
            }

            if (query.count) {
                return responseData.length;
            }

            if (query.sortBy) {
                const props = query.sortBy
                    .split(',')
                    .filter(p => p != '')
                    .map(p => p.split(' ').filter(p => p != ''))
                    .map(([p, desc]) => ({ prop: p, desc: desc ? true : false }));

                // Sorting priority is from first ot last, therefore we sort from last to first
                for (let i = props.length - 1; i >= 0; i--) {
                    let { prop, desc } = props[i];
                    responseData.sort(({ [prop]: propA }, { [prop]: propB }) => {
                        if (typeof propA == 'number' && typeof propB == 'number') {
                            return (propA - propB) * (desc ? -1 : 1);
                        } else {
                            return propA.localeCompare(propB) * (desc ? -1 : 1);
                        }
                    });
                }
            }

            if (query.offset) {
                responseData = responseData.slice(Number(query.offset) || 0);
            }
            const pageSize = Number(query.pageSize) || 10;
            if (query.pageSize) {
                responseData = responseData.slice(0, pageSize);
            }

            if (query.select) {
                const props = query.select.split(',').filter(p => p != '');
                responseData = Array.isArray(responseData) ? responseData.map(transform) : transform(responseData);

                function transform(r) {
                    const result = {};
                    props.forEach(p => result[p] = r[p]);
                    return result;
                }
            }

            if (query.load) {
                const props = query.load.split(',').filter(p => p != '');
                props.map(prop => {
                    const [propName, relationTokens] = prop.split('=');
                    const [idSource, collection] = relationTokens.split(':');
                    console.log(`Loading related records from "${collection}" into "${propName}", joined on "_id"="${idSource}"`);
                    const storageSource = collection == 'users' ? context.protectedStorage : context.storage;
                    responseData = Array.isArray(responseData) ? responseData.map(transform) : transform(responseData);

                    function transform(r) {
                        const seekId = r[idSource];
                        const related = storageSource.get(collection, seekId);
                        delete related.hashedPassword;
                        r[propName] = related;
                        return r;
                    }
                });
            }

        } catch (err) {
            console.error(err);
            if (err.message.includes('does not exist')) {
                throw new NotFoundError$1();
            } else {
                throw new RequestError$1(err.message);
            }
        }

        return responseData;
    }

    function post(context, tokens, query, body) {
        console.log('Request body:\n', body);

        validateRequest(context, tokens);
        if (tokens.length > 0) {
            throw new RequestError$1('Use PUT to update records');
        }

        let responseData;

        if (context.user) {
            body._ownerId = context.user._id;
        } else {
            throw new AuthorizationError$1();
        }

        try {
            responseData = context.storage.add(context.params.collection, body);
        } catch (err) {
            throw new RequestError$1();
        }

        return responseData;
    }

    function put(context, tokens, query, body) {
        console.log('Request body:\n', body);

        validateRequest(context, tokens);
        if (tokens.length != 1) {
            throw new RequestError$1('Missing entry ID');
        }

        let responseData;

        if (!context.user) {
            throw new AuthorizationError$1();
        }

        let existing;

        try {
            existing = context.storage.get(context.params.collection, tokens[0]);
        } catch (err) {
            throw new NotFoundError$1();
        }

        if (context.user._id !== existing._ownerId) {
            throw new CredentialError$1();
        }

        try {
            responseData = context.storage.set(context.params.collection, tokens[0], body);
        } catch (err) {
            throw new RequestError$1();
        }

        return responseData;
    }

    function del(context, tokens, query, body) {
        validateRequest(context, tokens);
        if (tokens.length != 1) {
            throw new RequestError$1('Missing entry ID');
        }

        let responseData;

        if (!context.user) {
            throw new AuthorizationError$1();
        }

        let existing;

        try {
            existing = context.storage.get(context.params.collection, tokens[0]);
        } catch (err) {
            throw new NotFoundError$1();
        }

        if (context.user._id !== existing._ownerId) {
            throw new CredentialError$1();
        }

        try {
            responseData = context.storage.delete(context.params.collection, tokens[0]);
        } catch (err) {
            throw new RequestError$1();
        }

        return responseData;
    }


    var data$1 = dataService$1.parseRequest;

    const imgdata = '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Td4DLneAwSddMiRH8tMU8nng/Yy+KQsM3AKBNbe35j5OH4A0dbV8AxwcAqMFyl73eHd3e2//nmn29wOGi3Kv+RixSgAAEkxpVFh0WE1MOmNvbS5hZG9iZS54bXAAAAAAADw/eHBhY2tldCBiZWdpbj0i77u/IiBpZD0iVzVNME1wQ2VoaUh6cmVTek5UY3prYzlkIj8+Cjx4OnhtcG1ldGEgeG1sbnM6eD0iYWRvYmU6bnM6bWV0YS8iIHg6eG1wdGs9IlhNUCBDb3JlIDQuNC4wLUV4aXYyIj4KIDxyZGY6UkRGIHhtbG5zOnJkZj0iaHR0cDovL3d3dy53My5vcmcvMTk5OS8wMi8yMi1yZGYtc3ludGF4LW5zIyI+CiAgPHJkZjpEZXNjcmlwdGlvbiByZGY6YWJvdXQ9IiIKICAgIHhtbG5zOmlwdGNFeHQ9Imh0dHA6Ly9pcHRjLm9yZy9zdGQvSXB0YzR4bXBFeHQvMjAwOC0wMi0yOS8iCiAgICB4bWxuczp4bXBNTT0iaHR0cDovL25zLmFkb2JlLmNvbS94YXAvMS4wL21tLyIKICAgIHhtbG5zOnN0RXZ0PSJodHRwOi8vbnMuYWRvYmUuY29tL3hhcC8xLjAvc1R5cGUvUmVzb3VyY2VFdmVudCMiCiAgICB4bWxuczpwbHVzPSJodHRwOi8vbnMudXNlcGx1cy5vcmcvbGRmL3htcC8xLjAvIgogICAgeG1sbnM6R0lNUD0iaHR0cDovL3d3dy5naW1wLm9yZy94bXAvIgogICAgeG1sbnM6ZGM9Imh0dHA6Ly9wdXJsLm9yZy9kYy9lbGVtZW50cy8xLjEvIgogICAgeG1sbnM6cGhvdG9zaG9wPSJodHRwOi8vbnMuYWRvYmUuY29tL3Bob3Rvc2hvcC8xLjAvIgogICAgeG1sbnM6eG1wPSJodHRwOi8vbnMuYWRvYmUuY29tL3hhcC8xLjAvIgogICAgeG1sbnM6eG1wUmlnaHRzPSJodHRwOi8vbnMuYWRvYmUuY29tL3hhcC8xLjAvcmlnaHRzLyIKICAgeG1wTU06RG9jdW1lbnRJRD0iZ2ltcDpkb2NpZDpnaW1wOjdjZDM3NWM3LTcwNmItNDlkMy1hOWRkLWNmM2Q3MmMwY2I4ZCIKICAgeG1wTU06SW5zdGFuY2VJRD0ieG1wLmlpZDo2NGY2YTJlYy04ZjA5LTRkZTMtOTY3ZC05MTUyY2U5NjYxNTAiCiAgIHhtcE1NOk9yaWdpbmFsRG9jdW1lbnRJRD0ieG1wLmRpZDoxMmE1NzI5Mi1kNmJkLTRlYjQtOGUxNi1hODEzYjMwZjU0NWYiCiAgIEdJTVA6QVBJPSIyLjAiCiAgIEdJTVA6UGxhdGZvcm09IldpbmRvd3MiCiAgIEdJTVA6VGltZVN0YW1wPSIxNjEzMzAwNzI5NTMwNjQzIgogICBHSU1QOlZlcnNpb249IjIuMTAuMTIiCiAgIGRjOkZvcm1hdD0iaW1hZ2UvcG5nIgogICBwaG90b3Nob3A6Q3JlZGl0PSJHZXR0eSBJbWFnZXMvaVN0b2NrcGhvdG8iCiAgIHhtcDpDcmVhdG9yVG9vbD0iR0lNUCAyLjEwIgogICB4bXBSaWdodHM6V2ViU3RhdGVtZW50PSJodHRwczovL3d3dy5pc3RvY2twaG90by5jb20vbGVnYWwvbGljZW5zZS1hZ3JlZW1lbnQ/dXRtX21lZGl1bT1vcmdhbmljJmFtcDt1dG1fc291cmNlPWdvb2dsZSZhbXA7dXRtX2NhbXBhaWduPWlwdGN1cmwiPgogICA8aXB0Y0V4dDpMb2NhdGlvbkNyZWF0ZWQ+CiAgICA8cmRmOkJhZy8+CiAgIDwvaXB0Y0V4dDpMb2NhdGlvbkNyZWF0ZWQ+CiAgIDxpcHRjRXh0OkxvY2F0aW9uU2hvd24+CiAgICA8cmRmOkJhZy8+CiAgIDwvaXB0Y0V4dDpMb2NhdGlvblNob3duPgogICA8aXB0Y0V4dDpBcnR3b3JrT3JPYmplY3Q+CiAgICA8cmRmOkJhZy8+CiAgIDwvaXB0Y0V4dDpBcnR3b3JrT3JPYmplY3Q+CiAgIDxpcHRjRXh0OlJlZ2lzdHJ5SWQ+CiAgICA8cmRmOkJhZy8+CiAgIDwvaXB0Y0V4dDpSZWdpc3RyeUlkPgogICA8eG1wTU06SGlzdG9yeT4KICAgIDxyZGY6U2VxPgogICAgIDxyZGY6bGkKICAgICAgc3RFdnQ6YWN0aW9uPSJzYXZlZCIKICAgICAgc3RFdnQ6Y2hhbmdlZD0iLyIKICAgICAgc3RFdnQ6aW5zdGFuY2VJRD0ieG1wLmlpZDpjOTQ2M2MxMC05OWE4LTQ1NDQtYmRlOS1mNzY0ZjdhODJlZDkiCiAgICAgIHN0RXZ0OnNvZnR3YXJlQWdlbnQ9IkdpbXAgMi4xMCAoV2luZG93cykiCiAgICAgIHN0RXZ0OndoZW49IjIwMjEtMDItMTRUMTM6MDU6MjkiLz4KICAgIDwvcmRmOlNlcT4KICAgPC94bXBNTTpIaXN0b3J5PgogICA8cGx1czpJbWFnZVN1cHBsaWVyPgogICAgPHJkZjpTZXEvPgogICA8L3BsdXM6SW1hZ2VTdXBwbGllcj4KICAgPHBsdXM6SW1hZ2VDcmVhdG9yPgogICAgPHJkZjpTZXEvPgogICA8L3BsdXM6SW1hZ2VDcmVhdG9yPgogICA8cGx1czpDb3B5cmlnaHRPd25lcj4KICAgIDxyZGY6U2VxLz4KICAgPC9wbHVzOkNvcHlyaWdodE93bmVyPgogICA8cGx1czpMaWNlbnNvcj4KICAgIDxyZGY6U2VxPgogICAgIDxyZGY6bGkKICAgICAgcGx1czpMaWNlbnNvclVSTD0iaHR0cHM6Ly93d3cuaXN0b2NrcGhvdG8uY29tL3Bob3RvL2xpY2Vuc2UtZ20xMTUwMzQ1MzQxLT91dG1fbWVkaXVtPW9yZ2FuaWMmYW1wO3V0bV9zb3VyY2U9Z29vZ2xlJmFtcDt1dG1fY2FtcGFpZ249aXB0Y3VybCIvPgogICAgPC9yZGY6U2VxPgogICA8L3BsdXM6TGljZW5zb3I+CiAgIDxkYzpjcmVhdG9yPgogICAgPHJkZjpTZXE+CiAgICAgPHJkZjpsaT5WbGFkeXNsYXYgU2VyZWRhPC9yZGY6bGk+CiAgICA8L3JkZjpTZXE+CiAgIDwvZGM6Y3JlYXRvcj4KICAgPGRjOmRlc2NyaXB0aW9uPgogICAgPHJkZjpBbHQ+CiAgICAgPHJkZjpsaSB4bWw6bGFuZz0ieC1kZWZhdWx0Ij5TZXJ2aWNlIHRvb2xzIGljb24gb24gd2hpdGUgYmFja2dyb3VuZC4gVmVjdG9yIGlsbHVzdHJhdGlvbi48L3JkZjpsaT4KICAgIDwvcmRmOkFsdD4KICAgPC9kYzpkZXNjcmlwdGlvbj4KICA8L3JkZjpEZXNjcmlwdGlvbj4KIDwvcmRmOlJERj4KPC94OnhtcG1ldGE+CiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAKPD94cGFja2V0IGVuZD0idyI/PmWJCnkAAAAGYktHRAD/AP8A/6C9p5MAAAAJcEhZcwAALiMAAC4jAXilP3YAAAAHdElNRQflAg4LBR0CZnO/AAAARHRFWHRDb21tZW50AFNlcnZpY2UgdG9vbHMgaWNvbiBvbiB3aGl0ZSBiYWNrZ3JvdW5kLiBWZWN0b3IgaWxsdXN0cmF0aW9uLlwvEeIAAAMxSURBVHja7Z1bcuQwCEX7qrLQXlp2ynxNVWbK7dgWj3sl9JvYRhxACD369erW7UMzx/cYaychonAQvXM5ABYkpynoYIiEGdoQog6AYfywBrCxF4zNrX/7McBbuXJe8rXx/KBDULcGsMREzCbeZ4J6ME/9wVH5d95rogZp3npEgPLP3m2iUSGqXBJS5Dr6hmLm8kRuZABYti5TMaailV8LodNQwTTUWk4/WZk75l0kM0aZQdaZjMqkrQDAuyMVJWFjMB4GANXr0lbZBxQKr7IjI7QvVWkok/Jn5UHVh61CYPs+/i7eL9j3y/Au8WqoAIC34k8/9k7N8miLcaGWHwgjZXE/awyYX7h41wKMCskZM2HXAddDkTdglpSjz5bcKPbcCEKwT3+DhxtVpJvkEC7rZSgq32NMSBoXaCdiahDCKrND0fpX8oQlVsQ8IFQZ1VARdIF5wroekAjB07gsAgDUIbQHFENIDEX4CQANIVe8Iw/ASiACLXl28eaf579OPuBa9/mrELUYHQ1t3KHlZZnRcXb2/c7ygXIQZqjDMEzeSrOgCAhqYMvTUE+FKXoVxTxgk3DEPREjGzj3nAk/VaKyB9GVIu4oMyOlrQZgrBBEFG9PAZTfs3amYDGrP9Wl964IeFvtz9JFluIvlEvcdoXDOdxggbDxGwTXcxFRi/LdirKgZUBm7SUdJG69IwSUzAMWgOAq/4hyrZVaJISSNWHFVbEoCFEhyBrCtXS9L+so9oTy8wGqxbQDD350WTjNESVFEB5hdKzUGcV5QtYxVWR2Ssl4Mg9qI9u6FCBInJRXgfEEgtS9Cgrg7kKouq4mdcDNBnEHQvWFTdgdgsqP+MiluVeBM13ahx09AYSWi50gsF+I6vn7BmCEoHR3NBzkpIOw4+XdVBBGQUioblaZHbGlodtB+N/jxqwLX/x/NARfD8ADxTOCKIcwE4Lw0OIbguMYcGTlymEpHYLXIKx8zQEqIfS2lGJPaADFEBR/PMH79ErqtpnZmTBlvM4wgihPWDEEhXn1LISj50crNgfCp+dWHYQRCfb2zgfnBZmKGAyi914anK9Coi4LOMhoAn3uVtn+AGnLKxPUZnCuAAAAAElFTkSuQmCC';
    const img = Buffer.from(imgdata, 'base64');

    var favicon = (method, tokens, query, body) => {
        console.log('serving favicon...');
        const headers = {
            'Content-Type': 'image/png',
            'Content-Length': img.length
        };
        let result = img;

        return {
            headers,
            result
        };
    };

    var require$$0 = "<!DOCTYPE html>\r\n<html lang=\"en\">\r\n<head>\r\n    <meta charset=\"UTF-8\">\r\n    <meta http-equiv=\"X-UA-Compatible\" content=\"IE=edge\">\r\n    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">\r\n    <title>SUPS Admin Panel</title>\r\n    <style>\r\n        * {\r\n            padding: 0;\r\n            margin: 0;\r\n        }\r\n\r\n        body {\r\n            padding: 32px;\r\n            font-size: 16px;\r\n        }\r\n\r\n        .layout::after {\r\n            content: '';\r\n            clear: both;\r\n            display: table;\r\n        }\r\n\r\n        .col {\r\n            display: block;\r\n            float: left;\r\n        }\r\n\r\n        p {\r\n            padding: 8px 16px;\r\n        }\r\n\r\n        table {\r\n            border-collapse: collapse;\r\n        }\r\n\r\n        caption {\r\n            font-size: 120%;\r\n            text-align: left;\r\n            padding: 4px 8px;\r\n            font-weight: bold;\r\n            background-color: #ddd;\r\n        }\r\n\r\n        table, tr, th, td {\r\n            border: 1px solid #ddd;\r\n        }\r\n\r\n        th, td {\r\n            padding: 4px 8px;\r\n        }\r\n\r\n        ul {\r\n            list-style: none;\r\n        }\r\n\r\n        .collection-list a {\r\n            display: block;\r\n            width: 120px;\r\n            padding: 4px 8px;\r\n            text-decoration: none;\r\n            color: black;\r\n            background-color: #ccc;\r\n        }\r\n        .collection-list a:hover {\r\n            background-color: #ddd;\r\n        }\r\n        .collection-list a:visited {\r\n            color: black;\r\n        }\r\n    </style>\r\n    <script type=\"module\">\nimport { html, render } from 'https://unpkg.com/lit-html?module';\nimport { until } from 'https://unpkg.com/lit-html/directives/until?module';\n\nconst api = {\r\n    async get(url) {\r\n        return json(url);\r\n    },\r\n    async post(url, body) {\r\n        return json(url, {\r\n            method: 'POST',\r\n            headers: { 'Content-Type': 'application/json' },\r\n            body: JSON.stringify(body)\r\n        });\r\n    }\r\n};\r\n\r\nasync function json(url, options) {\r\n    return await (await fetch('/' + url, options)).json();\r\n}\r\n\r\nasync function getCollections() {\r\n    return api.get('data');\r\n}\r\n\r\nasync function getRecords(collection) {\r\n    return api.get('data/' + collection);\r\n}\r\n\r\nasync function getThrottling() {\r\n    return api.get('util/throttle');\r\n}\r\n\r\nasync function setThrottling(throttle) {\r\n    return api.post('util', { throttle });\r\n}\n\nasync function collectionList(onSelect) {\r\n    const collections = await getCollections();\r\n\r\n    return html`\r\n    <ul class=\"collection-list\">\r\n        ${collections.map(collectionLi)}\r\n    </ul>`;\r\n\r\n    function collectionLi(name) {\r\n        return html`<li><a href=\"javascript:void(0)\" @click=${(ev) => onSelect(ev, name)}>${name}</a></li>`;\r\n    }\r\n}\n\nasync function recordTable(collectionName) {\r\n    const records = await getRecords(collectionName);\r\n    const layout = getLayout(records);\r\n\r\n    return html`\r\n    <table>\r\n        <caption>${collectionName}</caption>\r\n        <thead>\r\n            <tr>${layout.map(f => html`<th>${f}</th>`)}</tr>\r\n        </thead>\r\n        <tbody>\r\n            ${records.map(r => recordRow(r, layout))}\r\n        </tbody>\r\n    </table>`;\r\n}\r\n\r\nfunction getLayout(records) {\r\n    const result = new Set(['_id']);\r\n    records.forEach(r => Object.keys(r).forEach(k => result.add(k)));\r\n\r\n    return [...result.keys()];\r\n}\r\n\r\nfunction recordRow(record, layout) {\r\n    return html`\r\n    <tr>\r\n        ${layout.map(f => html`<td>${JSON.stringify(record[f]) || html`<span>(missing)</span>`}</td>`)}\r\n    </tr>`;\r\n}\n\nasync function throttlePanel(display) {\r\n    const active = await getThrottling();\r\n\r\n    return html`\r\n    <p>\r\n        Request throttling: </span>${active}</span>\r\n        <button @click=${(ev) => set(ev, true)}>Enable</button>\r\n        <button @click=${(ev) => set(ev, false)}>Disable</button>\r\n    </p>`;\r\n\r\n    async function set(ev, state) {\r\n        ev.target.disabled = true;\r\n        await setThrottling(state);\r\n        display();\r\n    }\r\n}\n\n//import page from '//unpkg.com/page/page.mjs';\r\n\r\n\r\nfunction start() {\r\n    const main = document.querySelector('main');\r\n    editor(main);\r\n}\r\n\r\nasync function editor(main) {\r\n    let list = html`<div class=\"col\">Loading&hellip;</div>`;\r\n    let viewer = html`<div class=\"col\">\r\n    <p>Select collection to view records</p>\r\n</div>`;\r\n    display();\r\n\r\n    list = html`<div class=\"col\">${await collectionList(onSelect)}</div>`;\r\n    display();\r\n\r\n    async function display() {\r\n        render(html`\r\n        <section class=\"layout\">\r\n            ${until(throttlePanel(display), html`<p>Loading</p>`)}\r\n        </section>\r\n        <section class=\"layout\">\r\n            ${list}\r\n            ${viewer}\r\n        </section>`, main);\r\n    }\r\n\r\n    async function onSelect(ev, name) {\r\n        ev.preventDefault();\r\n        viewer = html`<div class=\"col\">${await recordTable(name)}</div>`;\r\n        display();\r\n    }\r\n}\r\n\r\nstart();\n\n</script>\r\n</head>\r\n<body>\r\n    <main>\r\n        Loading&hellip;\r\n    </main>\r\n</body>\r\n</html>";

    const mode = process.argv[2] == '-dev' ? 'dev' : 'prod';

    const files = {
        index: mode == 'prod' ? require$$0 : fs__default['default'].readFileSync('./client/index.html', 'utf-8')
    };

    var admin = (method, tokens, query, body) => {
        const headers = {
            'Content-Type': 'text/html'
        };
        let result = '';

        const resource = tokens.join('/');
        if (resource && resource.split('.').pop() == 'js') {
            headers['Content-Type'] = 'application/javascript';

            files[resource] = files[resource] || fs__default['default'].readFileSync('./client/' + resource, 'utf-8');
            result = files[resource];
        } else {
            result = files.index;
        }

        return {
            headers,
            result
        };
    };

    /*
     * This service requires util plugin
     */

    const utilService = new Service_1();

    utilService.post('*', onRequest);
    utilService.get(':service', getStatus);

    function getStatus(context, tokens, query, body) {
        return context.util[context.params.service];
    }

    function onRequest(context, tokens, query, body) {
        Object.entries(body).forEach(([k,v]) => {
            console.log(`${k} ${v ? 'enabled' : 'disabled'}`);
            context.util[k] = v;
        });
        return '';
    }

    var util$1 = utilService.parseRequest;

    var services = {
        jsonstore,
        users,
        data: data$1,
        favicon,
        admin,
        util: util$1
    };

    const { uuid: uuid$2 } = util;


    function initPlugin(settings) {
        const storage = createInstance(settings.seedData);
        const protectedStorage = createInstance(settings.protectedData);

        return function decoreateContext(context, request) {
            context.storage = storage;
            context.protectedStorage = protectedStorage;
        };
    }


    /**
     * Create storage instance and populate with seed data
     * @param {Object=} seedData Associative array with data. Each property is an object with properties in format {key: value}
     */
    function createInstance(seedData = {}) {
        const collections = new Map();

        // Initialize seed data from file    
        for (let collectionName in seedData) {
            if (seedData.hasOwnProperty(collectionName)) {
                const collection = new Map();
                for (let recordId in seedData[collectionName]) {
                    if (seedData.hasOwnProperty(collectionName)) {
                        collection.set(recordId, seedData[collectionName][recordId]);
                    }
                }
                collections.set(collectionName, collection);
            }
        }


        // Manipulation

        /**
         * Get entry by ID or list of all entries from collection or list of all collections
         * @param {string=} collection Name of collection to access. Throws error if not found. If omitted, returns list of all collections.
         * @param {number|string=} id ID of requested entry. Throws error if not found. If omitted, returns of list all entries in collection.
         * @return {Object} Matching entry.
         */
        function get(collection, id) {
            if (!collection) {
                return [...collections.keys()];
            }
            if (!collections.has(collection)) {
                throw new ReferenceError('Collection does not exist: ' + collection);
            }
            const targetCollection = collections.get(collection);
            if (!id) {
                const entries = [...targetCollection.entries()];
                let result = entries.map(([k, v]) => {
                    return Object.assign(deepCopy(v), { _id: k });
                });
                return result;
            }
            if (!targetCollection.has(id)) {
                throw new ReferenceError('Entry does not exist: ' + id);
            }
            const entry = targetCollection.get(id);
            return Object.assign(deepCopy(entry), { _id: id });
        }

        /**
         * Add new entry to collection. ID will be auto-generated
         * @param {string} collection Name of collection to access. If the collection does not exist, it will be created.
         * @param {Object} data Value to store.
         * @return {Object} Original value with resulting ID under _id property.
         */
        function add(collection, data) {
            const record = assignClean({ _ownerId: data._ownerId }, data);

            let targetCollection = collections.get(collection);
            if (!targetCollection) {
                targetCollection = new Map();
                collections.set(collection, targetCollection);
            }
            let id = uuid$2();
            // Make sure new ID does not match existing value
            while (targetCollection.has(id)) {
                id = uuid$2();
            }

            record._createdOn = Date.now();
            targetCollection.set(id, record);
            return Object.assign(deepCopy(record), { _id: id });
        }

        /**
         * Update entry by ID
         * @param {string} collection Name of collection to access. Throws error if not found.
         * @param {number|string} id ID of entry to update. Throws error if not found.
         * @param {Object} data Value to store. Shallow merge will be performed!
         * @return {Object} Updated entry.
         */
        function set(collection, id, data) {
            if (!collections.has(collection)) {
                throw new ReferenceError('Collection does not exist: ' + collection);
            }
            const targetCollection = collections.get(collection);
            if (!targetCollection.has(id)) {
                throw new ReferenceError('Entry does not exist: ' + id);
            }

            const existing = deepCopy(targetCollection.get(id));
            const record = assignClean(existing, data);
            record._updatedOn = Date.now();
            targetCollection.set(id, record);
            return Object.assign(deepCopy(record), { _id: id });
        }

        /**
         * Delete entry by ID
         * @param {string} collection Name of collection to access. Throws error if not found.
         * @param {number|string} id ID of entry to update. Throws error if not found.
         * @return {{_deletedOn: number}} Server time of deletion.
         */
        function del(collection, id) {
            if (!collections.has(collection)) {
                throw new ReferenceError('Collection does not exist: ' + collection);
            }
            const targetCollection = collections.get(collection);
            if (!targetCollection.has(id)) {
                throw new ReferenceError('Entry does not exist: ' + id);
            }
            targetCollection.delete(id);

            return { _deletedOn: Date.now() };
        }

        /**
         * Search in collection by query object
         * @param {string} collection Name of collection to access. Throws error if not found.
         * @param {Object} query Query object. Format {prop: value}.
         * @return {Object[]} Array of matching entries.
         */
        function query(collection, query) {
            if (!collections.has(collection)) {
                throw new ReferenceError('Collection does not exist: ' + collection);
            }
            const targetCollection = collections.get(collection);
            const result = [];
            // Iterate entries of target collection and compare each property with the given query
            for (let [key, entry] of [...targetCollection.entries()]) {
                let match = true;
                for (let prop in entry) {
                    if (query.hasOwnProperty(prop)) {
                        const targetValue = query[prop];
                        // Perform lowercase search, if value is string
                        if (typeof targetValue === 'string' && typeof entry[prop] === 'string') {
                            if (targetValue.toLocaleLowerCase() !== entry[prop].toLocaleLowerCase()) {
                                match = false;
                                break;
                            }
                        } else if (targetValue != entry[prop]) {
                            match = false;
                            break;
                        }
                    }
                }

                if (match) {
                    result.push(Object.assign(deepCopy(entry), { _id: key }));
                }
            }

            return result;
        }

        return { get, add, set, delete: del, query };
    }


    function assignClean(target, entry, ...rest) {
        const blacklist = [
            '_id',
            '_createdOn',
            '_updatedOn',
            '_ownerId'
        ];
        for (let key in entry) {
            if (blacklist.includes(key) == false) {
                target[key] = deepCopy(entry[key]);
            }
        }
        if (rest.length > 0) {
            Object.assign(target, ...rest);
        }

        return target;
    }

    function deepCopy(value) {
        if (Array.isArray(value)) {
            return value.map(deepCopy);
        } else if (typeof value == 'object') {
            return [...Object.entries(value)].reduce((p, [k, v]) => Object.assign(p, { [k]: deepCopy(v) }), {});
        } else {
            return value;
        }
    }

    var storage = initPlugin;

    const { ConflictError: ConflictError$1, CredentialError: CredentialError$2, RequestError: RequestError$2 } = errors;

    function initPlugin$1(settings) {
        const identity = settings.identity;

        return function decorateContext(context, request) {
            context.auth = {
                register,
                login,
                logout
            };

            const userToken = request.headers['x-authorization'];
            if (userToken !== undefined) {
                let user;
                const session = findSessionByToken(userToken);
                if (session !== undefined) {
                    const userData = context.protectedStorage.get('users', session.userId);
                    if (userData !== undefined) {
                        console.log('Authorized as ' + userData[identity]);
                        user = userData;
                    }
                }
                if (user !== undefined) {
                    context.user = user;
                } else {
                    throw new CredentialError$2('Invalid access token');
                }
            }

            function register(body) {
                if (body.hasOwnProperty(identity) === false ||
                    body.hasOwnProperty('password') === false ||
                    body[identity].length == 0 ||
                    body.password.length == 0) {
                    throw new RequestError$2('Missing fields');
                } else if (context.protectedStorage.query('users', { [identity]: body[identity] }).length !== 0) {
                    throw new ConflictError$1(`A user with the same ${identity} already exists`);
                } else {
                    const newUser = {
                        [identity]: body[identity],
                        hashedPassword: hash(body.password)
                    };
                    const result = context.protectedStorage.add('users', newUser);
                    delete result.hashedPassword;

                    const session = saveSession(result._id);
                    result.accessToken = session.accessToken;

                    return result;
                }
            }

            function login(body) {
                const targetUser = context.protectedStorage.query('users', { [identity]: body[identity] });
                if (targetUser.length == 1) {
                    if (hash(body.password) === targetUser[0].hashedPassword) {
                        const result = targetUser[0];
                        delete result.hashedPassword;

                        const session = saveSession(result._id);
                        result.accessToken = session.accessToken;

                        return result;
                    } else {
                        throw new CredentialError$2('Email or password don\'t match');
                    }
                } else {
                    throw new CredentialError$2('Email or password don\'t match');
                }
            }

            function logout() {
                if (context.user !== undefined) {
                    const session = findSessionByUserId(context.user._id);
                    if (session !== undefined) {
                        context.protectedStorage.delete('sessions', session._id);
                    }
                } else {
                    throw new CredentialError$2('User session does not exist');
                }
            }

            function saveSession(userId) {
                let session = context.protectedStorage.add('sessions', { userId });
                const accessToken = hash(session._id);
                session = context.protectedStorage.set('sessions', session._id, Object.assign({ accessToken }, session));
                return session;
            }

            function findSessionByToken(userToken) {
                return context.protectedStorage.query('sessions', { accessToken: userToken })[0];
            }

            function findSessionByUserId(userId) {
                return context.protectedStorage.query('sessions', { userId })[0];
            }
        };
    }


    const secret = 'This is not a production server';

    function hash(string) {
        const hash = crypto__default['default'].createHmac('sha256', secret);
        hash.update(string);
        return hash.digest('hex');
    }

    var auth = initPlugin$1;

    function initPlugin$2(settings) {
        const util = {
            throttle: false
        };

        return function decoreateContext(context, request) {
            context.util = util;
        };
    }

    var util$2 = initPlugin$2;

    var identity = "email";
    var protectedData = {
    	users: {
    		"35c62d76-8152-4626-8712-eeb96381bea8": {
    			email: "peter@abv.bg",
    			hashedPassword: "83313014ed3e2391aa1332615d2f053cf5c1bfe05ca1cbcb5582443822df6eb1",
          name: "Peter Ivanov",
          age: "31",
          city: "Sofia",
          img: "https://i.pinimg.com/originals/97/e4/2a/97e42a82fc7911961d3ca55f54d1372c.jpg",
          _createdOn: "2023-07-12 22:06:27"
    		},
    		"847ec027-f659-4086-8032-5173e2f9c93a": {
    			email: "george@abv.bg",
    			hashedPassword: "83313014ed3e2391aa1332615d2f053cf5c1bfe05ca1cbcb5582443822df6eb1",
          name: "George Georgiev",
          age: "28",
          city: "Ruse",
          img: "https://www.clinicdermatech.com/images/men-service-face.jpg",
          _createdOn: "2023-06-12 22:06:27"
    		},
    		"60f0cf0b-34b0-4abd-9769-8c42f830dffc": {
    			email: "admin@abv.bg",
    			hashedPassword: "83313014ed3e2391aa1332615d2f053cf5c1bfe05ca1cbcb5582443822df6eb1",
          name: "Admin Adminov",
          age: "33",
          city: "Any",
          img: "https://i.pinimg.com/originals/f6/a9/cf/f6a9cff61e65a034fce9b54420cc6ff5.jpg",
          _createdOn: "2023-03-12 22:06:27"
    		},
        "455b415d-ce09-4895-986e-b8ce1a799a48": {
    			email: "billgates@gmail.com",
    			hashedPassword: "83313014ed3e2391aa1332615d2f053cf5c1bfe05ca1cbcb5582443822df6eb1",
          name: "Bill Gates",
          age: "67",
          city: "Seattle",
          img: "https://upload.wikimedia.org/wikipedia/commons/thumb/a/a8/Bill_Gates_2017_%28cropped%29.jpg/220px-Bill_Gates_2017_%28cropped%29.jpg",
          _createdOn: "2023-07-12 20:08:47"
    		}
    	},
    	sessions: {
    	}
    };
    var seedData = {
    	lists: {
            "1" : {
              "display_name": "Hardcover Fiction",
            },
            "2" : {
              "display_name": "Hardcover Nonfiction",
            },
            "17" : {
              "display_name": "Paperback Trade Fiction",
            },
            "4" : {
              "display_name": "Paperback Nonfiction",
            },
            "24" : {
              "display_name": "Advice, How-To & Miscellaneous",
            },
            "13" : {
              "display_name": "Children’s Middle Grade Hardcover",
            },
            "7" : {
              "display_name": "Children’s Picture Books",
            },
            "10" : {
              "display_name": "Children’s Series",
            },
            "14" : {
              "display_name": "Young Adult Hardcover",
            },
            "301" : {
              "display_name": "Audio Fiction",
            },
            "302" : {
              "display_name": "Audio Nonfiction",
            },
            "532" : {
              "display_name": "Business", 
            },
            "719" : {
              "display_name": "Graphic Books and Manga",
            },
            "10018" : {
              "display_name": "Mass Market",
            },
            "10015" : {
              "display_name": "Middle Grade Paperback",
            },
            "10016" : {
              "display_name": "Young Adult Paperback",
            }
      },
      books: {
          "106c2cf0-7d20-51b1-bad4-91c3ebcd131a": {
            "_listId": "1",
            "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
            "author": "Rebecca Yarros",
            "book_image": "https://storage.googleapis.com/du-prd/books/images/9781649374042.jpg",
            "_createdOn": "2023-07-12 22:06:21",
            "description": "Violet Sorrengail is urged by the commanding general, who also is her mother, to become a candidate for the elite dragon riders.",
            "title": "FOURTH WING",
          },
          "9ab3a59a-e572-5452-ae0c-eedeadb05831": {
            "_listId": "1",
            "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
            "author": "Emily Henry",
            "book_image": "https://storage.googleapis.com/du-prd/books/images/9780593441275.jpg",
            "_createdOn": "2023-07-12 22:06:21",
            "description": "A former couple pretend to be together for the sake of their friends during their annual getaway in Maine.",
            "title": "HAPPY PLACE",
          },
          "717e0ead-9782-567d-af27-d9a6cfb1856f": {
            "_listId": "1",
            "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
            "author": "Bonnie Garmus",
            "book_image": "https://storage.googleapis.com/du-prd/books/images/9780385547345.jpg",
            "_createdOn": "2023-07-12 22:06:21",
            "description": "A scientist and single mother living in California in the 1960s becomes a star on a TV cooking show.",
            "title": "LESSONS IN CHEMISTRY",
          },
          "8c779b4e-ab10-5946-a522-e8dd1167b1db": {
            "_listId": "1",
            "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
            "author": "Elin Hilderbrand",
            "book_image": "https://storage.googleapis.com/du-prd/books/images/9780316258777.jpg",
            "_createdOn": "2023-07-12 22:06:21",
            "description": "After a tragedy, a popular food blogger brings friends from distinct times in her life to spend a weekend in Nantucket.",
            "title": "THE FIVE-STAR WEEKEND",
          },
          "5ebf1d34-4c68-560a-8330-7e65bedaaa1a": {
            "_listId": "1",
            "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
            "author": "Abraham Verghese",
            "book_image": "https://storage.googleapis.com/du-prd/books/images/9780802162175.jpg",
            "_createdOn": "2023-07-12 22:06:21",
            "description": "Three generations of a family living on South India’s Malabar Coast suffer the loss of a family member by drowning.",
            "title": "THE COVENANT OF WATER",
          },
          "dd6e4f9d-d082-552d-b888-7276a25b5aca": {
            "_listId": "1",
            "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
            "author": "Barbara Kingsolver",
            "book_image": "https://storage.googleapis.com/du-prd/books/images/9780063251922.jpg",
            "_createdOn": "2023-07-12 22:06:21",
            "description": "Winner of a 2023 Pulitzer Prize for fiction. A reimagining of Charles Dickens’s “David Copperfield” set in the mountains of southern Appalachia.",
            "title": "DEMON COPPERHEAD",
          },
          "69f6e624-4f30-59d6-8103-816d17ae5ec1": {
            "_listId": "2",
            "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
            "author": "Peter Attia with Bill Gifford",
            "book_image": "https://storage.googleapis.com/du-prd/books/images/9780593236598.jpg",
            "_createdOn": "2023-07-12 22:06:24",
            "description": "A look at recent scientific research on aging and longevity.",
            "title": "OUTLIVE",
          },
          "92ec85ca-4cff-59b6-94a3-b81002bfc8e6": {
            "_listId": "2",
            "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
            "author": "David Grann",
            "book_image": "https://storage.googleapis.com/du-prd/books/images/9780385534260.jpg",
            "_createdOn": "2023-07-12 22:06:24",
            "description": "The survivors of a shipwrecked British vessel on a secret mission during an imperial war with Spain have different accounts of events.",
            "title": "THE WAGER",
          },
          "be73b1c3-c238-5232-af55-bf70c59cb907": {
            "_listId": "2",
            "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
            "author": "Jennette McCurdy",
            "book_image": "https://storage.googleapis.com/du-prd/books/images/9781982185824.jpg",
            "_createdOn": "2023-07-12 22:06:24",
            "description": "The actress and filmmaker describes her eating disorders and difficult relationship with her mother.",
            "title": "I'M GLAD MY MOM DIED",
          },
          "eb3987a4-4026-5b92-a086-b1dc4dbad328": {
            "_listId": "2",
            "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
            "author": "Johnny Joey Jones",
            "book_image": "https://storage.googleapis.com/du-prd/books/images/9780063226081.jpg",
            "_createdOn": "2023-07-12 22:06:24",
            "description": "The Fox News military analyst shares stories from working with veterans for over a decade.",
            "title": "UNBROKEN BONDS OF BATTLE",
          },
          "9b321428-2ecb-5584-a5d3-513e79cb9a63": {
            "_listId": "2",
            "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
            "author": "Paul McCartney",
            "book_image": "https://storage.googleapis.com/du-prd/books/images/9781324093060.jpg",
            "_createdOn": "2023-07-12 22:06:25",
            "description": "A collection of photographs taken with a 35-millimeter camera during the rise of the Beatles from the end of 1963 through early 1964.",
            "title": "1964",
          },
          "9699c550-34ce-56c6-a242-3359bdeca897": {
            "_listId": "2",
            "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
            "author": "Hadley Vlahos",
            "book_image": "https://storage.googleapis.com/du-prd/books/images/9780593499931.jpg",
            "_createdOn": "2023-07-12 22:06:25",
            "description": "A hospice nurse shares some of her most impactful experiences and questions some of society's beliefs around end-of-life care.",
            "title": "THE IN-BETWEEN",
          },
          "0962ac94-2f91-5500-bcf8-24c90607bc4a": {
            "_listId": "17",
            "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
            "author": "Colleen Hoover",
            "book_image": "https://storage.googleapis.com/du-prd/books/images/9781538756591.jpg",
            "_createdOn": "2023-07-12 22:06:23",
            "description": "Dangers develop when a drug trafficker becomes obsessed with a woman who has a mutual attraction to a D.E.A. agent.",
            "title": "TOO LATE",
          },
          "e2a3545e-e9cb-5828-9d97-50a798a0e4f6": {
            "_listId": "17",
            "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
            "author": "Colleen Hoover",
            "book_image": "https://storage.googleapis.com/du-prd/books/images/9781501110375.jpg",
            "_createdOn": "2023-07-12 22:06:24",
            "description": "A battered wife raised in a violent home attempts to halt the cycle of abuse.",
            "title": "IT ENDS WITH US",
          },
          "3aa85e47-4df9-53ef-9957-a77753d3502c": {
            "_listId": "17",
            "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
            "author": "Colleen Hoover",
            "book_image": "https://storage.googleapis.com/du-prd/books/images/9781668001226.jpg",
            "_createdOn": "2023-07-12 22:06:24",
            "description": "In the sequel to “It Ends With Us,” Lily deals with her jealous ex-husband as she reconnects with her first boyfriend.",
            "title": "IT STARTS WITH US",
          },
          "a89bf395-aba9-520b-bf2b-7e6245e89ef9": {
            "_listId": "17",
            "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
            "author": "Hannah Grace",
            "book_image": "https://storage.googleapis.com/du-prd/books/images/9781668026038.jpg",
            "_createdOn": "2023-07-12 22:06:24",
            "description": "Anastasia might need the help of the captain of a college hockey team to get on the Olympic figure skating team.",
            "title": "ICEBREAKER",
          },
          "013c7729-a1de-5e5c-921a-da43243f9a4a": {
            "_listId": "17",
            "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
            "author": "Colleen Hoover",
            "book_image": "https://storage.googleapis.com/du-prd/books/images/9781791392796.jpg",
            "_createdOn": "2023-07-12 22:06:24",
            "description": "Lowen Ashleigh is hired by the husband of an injured writer to complete her popular series and uncovers a horrifying truth.",
            "title": "VERITY",
          },
          "d9511fac-ee44-5a87-9af7-2cd6a6f8f984": {
            "_listId": "17",
            "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
            "author": "Taylor Jenkins Reid",
            "book_image": "https://storage.googleapis.com/du-prd/books/images/9781501161933.jpg",
            "_createdOn": "2023-07-12 22:06:24",
            "description": "A movie icon recounts stories of her loves and career to a struggling magazine writer.",
            "title": "THE SEVEN HUSBANDS OF EVELYN HUGO",
          },
          "c5c1cd05-cdbc-5e7a-8255-1923ab4b1ceb": {
            "_listId": "4",
            "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
            "author": "David Grann",
            "book_image": "https://storage.googleapis.com/du-prd/books/images/9780385534246.jpg",
            "_createdOn": "2023-07-12 22:06:26",
            "description": "The story of a murder spree in 1920s Oklahoma that targeted Osage Indians, whose lands contained oil. The fledgling F.B.I. intervened, ineffectively.",
            "title": "KILLERS OF THE FLOWER MOON",
          },
          "e3e33e9d-0e67-5fec-b0d2-2ecddc38ce0e": {
            "_listId": "4",
            "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
            "author": "Bessel van der Kolk",
            "book_image": "https://storage.googleapis.com/du-prd/books/images/9780670785933.jpg",
            "_createdOn": "2023-07-12 22:06:26",
            "description": "How trauma affects the body and mind, and innovative treatments for recovery.",
            "title": "THE BODY KEEPS THE SCORE",
          },
          "520cb070-10ce-5d43-9b0c-e77f57d84a8d": {
            "_listId": "4",
            "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
            "author": "Michelle Zauner",
            "book_image": "https://storage.googleapis.com/du-prd/books/images/9780525657743.jpg",
            "_createdOn": "2023-07-12 22:06:26",
            "description": "The daughter of a Korean mother and Jewish American father, and leader of the indie rock project Japanese Breakfast, describes creating her own identity after losing her mother to cancer.",
            "title": "CRYING IN H MART",
          },
          "84ce374b-f6b1-5f05-8556-b0e09e97679c": {
            "_listId": "4",
            "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
            "author": "bell hooks",
            "book_image": "https://storage.googleapis.com/du-prd/books/images/9780060959470.jpg",
            "_createdOn": "2023-07-12 22:06:26",
            "description": "The late feminist icon explores the causes of a polarized society and the meaning of love.",
            "title": "ALL ABOUT LOVE",
          },
          "194ea111-42ad-5795-9fb5-3e155ffa5e79": {
            "_listId": "4",
            "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
            "author": "Robin Wall Kimmerer",
            "book_image": "https://storage.googleapis.com/du-prd/books/images/9781571313560.jpg",
            "_createdOn": "2023-07-12 22:06:26",
            "description": "A botanist and member of the Citizen Potawatomi Nation espouses having an understanding and appreciation of plants and animals.",
            "title": "BRAIDING SWEETGRASS",
          },
          "78725ce3-7ae4-5a35-acad-04355f2d0b44": {
            "_listId": "4",
            "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
            "author": "Dolly Alderton",
            "book_image": "https://storage.googleapis.com/du-prd/books/images/9780062968791.jpg",
            "_createdOn": "2023-07-12 22:06:26",
            "description": "The British journalist shares stories and observations; the basis of the TV series.",
            "title": "EVERYTHING I KNOW ABOUT LOVE",
          },
          "0398a355-c032-534e-a0af-647b06f0840d": {
            "_listId": "24",
            "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
            "author": "James Clear",
            "book_image": "https://storage.googleapis.com/du-prd/books/images/9780735211292.jpg",
            "_createdOn": "2023-07-12 22:06:25",
            "description": "",
            "title": "ATOMIC HABITS",
          },
          "da28ca16-1ebd-55aa-aba3-fde278604a82": {
            "_listId": "24",
            "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
            "author": "Rick Rubin with Neil Strauss",
            "book_image": "https://storage.googleapis.com/du-prd/books/images/9780593652886.jpg",
            "_createdOn": "2023-07-12 22:06:25",
            "description": "",
            "title": "THE CREATIVE ACT",
          },
          "61980bbe-79bd-5824-9412-31c5f07762fd": {
            "_listId": "24",
            "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
            "author": "Mark Manson",
            "book_image": "https://storage.googleapis.com/du-prd/books/images/9780062457714.jpg",
            "_createdOn": "2023-07-12 22:06:25",
            "description": "",
            "title": "THE SUBTLE ART OF NOT GIVING A F*CK",
          },
          "cad7f15b-73d9-5097-89f3-bc2ea602617e": {
            "_listId": "24",
            "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
            "author": "David Goggins",
            "book_image": "https://storage.googleapis.com/du-prd/books/images/9781544512280.jpg",
            "_createdOn": "2023-07-12 22:06:25",
            "description": "",
            "title": "CAN'T HURT ME",
          },
          "95d8c42e-e90e-53e6-a7ec-c2fb3305a933": {
            "_listId": "24",
            "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
            "author": "Joanna Gaines",
            "book_image": "https://storage.googleapis.com/du-prd/books/images/9780062820174.jpg",
            "_createdOn": "2023-07-12 22:06:25",
            "description": "",
            "title": "MAGNOLIA TABLE, VOL. 3",
          },
          "b98f7ad9-aa29-5b5d-bee0-1aae5a523991": {
            "_listId": "24",
            "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
            "author": "Ramin Zahed.",
            "book_image": "https://storage.googleapis.com/du-prd/books/images/9781419763991.jpg",
            "_createdOn": "2023-07-12 22:06:25",
            "description": "",
            "title": "SPIDER-MAN: ACROSS THE SPIDER-VERSE: THE ART OF THE MOVIE",
          },
          "8384c64a-d0de-5285-9132-8f16cc7b085f": {
            "_listId": "13",
            "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
            "author": "Rick Riordan and Mark Oshiro",
            "book_image": "https://storage.googleapis.com/du-prd/books/images/9781368081153.jpg",
            "_createdOn": "2023-07-12 22:06:22",
            "description": "The demigods Will and Nico embark on a dangerous journey to the Underworld to rescue an old friend.",
            "title": "THE SUN AND THE STAR",
          },
          "32519cc3-8ee6-5bc8-9a1a-563502a5d2ad": {
            "_listId": "13",
            "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
            "author": "Alan Gratz",
            "book_image": "https://storage.googleapis.com/du-prd/books/images/9780545880831.jpg",
            "_createdOn": "2023-07-12 22:06:22",
            "description": "Three children in three different conflicts look for safe haven.",
            "title": "REFUGEE",
          },
          "ae6bd2cf-a5d7-535a-99dd-ca8e283c2b01": {
            "_listId": "13",
            "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
            "author": "R.J. Palacio",
            "book_image": "https://storage.googleapis.com/du-prd/books/images/9780375899881.jpg",
            "_createdOn": "2023-07-12 22:06:23",
            "description": "A boy with a facial deformity starts school.",
            "title": "WONDER",
          },
          "894e62dd-9e61-570a-ad32-6f4617d323e5": {
            "_listId": "13",
            "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
            "author": "America's Test Kitchen Kids",
            "book_image": "https://storage.googleapis.com/du-prd/books/images/9781492670025.jpg",
            "_createdOn": "2023-07-12 22:06:23",
            "description": "Over 100 kid-tested recipes from America's Test Kitchen.",
            "title": "THE COMPLETE COOKBOOK FOR YOUNG CHEFS",
          },
          "7cbb7e64-5062-5c47-ab17-1fc816718047": {
            "_listId": "13",
            "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
            "author": "Steven Rinella with Brody Henderson.",
            "book_image": "https://storage.googleapis.com/du-prd/books/images/9780593448977.jpg",
            "_createdOn": "2023-07-12 22:06:23",
            "description": "Over 70 adventures and activities for outdoor kids.",
            "title": "CATCH A CRAYFISH, COUNT THE STARS",
          },
          "aa5397d3-ccd0-5f9c-b6d3-032823aaabb6": {
            "_listId": "13",
            "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
            "author": "Wanda Coven.",
            "book_image": "https://storage.googleapis.com/du-prd/books/images/9781665925280.jpg",
            "_createdOn": "2023-07-12 22:06:23",
            "description": "Old rivals, Heidi and Melanie find out they're roommates at the Broomsfield Academy.",
            "title": "WORST BROOMMATE EVER!",
          },
          "36cac861-60d3-511f-ba6d-edc88c6e938e": {
            "_listId": "7",
            "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
            "author": "Emily Winfield Martin",
            "book_image": "https://storage.googleapis.com/du-prd/books/images/9780385376716.jpg",
            "_createdOn": "2023-07-12 22:06:26",
            "description": "A celebration of future possibilities.",
            "title": "THE WONDERFUL THINGS YOU WILL BE",
          },
          "4f943620-3fd7-58ea-8ce8-e15e16c47232": {
            "_listId": "7",
            "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
            "author": "Adam Wallace.",
            "book_image": "https://storage.googleapis.com/du-prd/books/images/9781492662471.jpg",
            "_createdOn": "2023-07-12 22:06:26",
            "description": "A young girl attempts to catch a mermaid and befriend her.",
            "title": "HOW TO CATCH A MERMAID",
          },
          "c45cf6ec-9c12-534e-99a7-c443a0d375ff": {
            "_listId": "7",
            "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
            "author": "Adam Wallace.",
            "book_image": "https://storage.googleapis.com/du-prd/books/images/9781492669739.jpg",
            "_createdOn": "2023-07-12 22:06:27",
            "description": "Children attempt to capture the mythical creature.",
            "title": "HOW TO CATCH A UNICORN",
          },
          "25d4f970-1f30-515b-a88c-691b4854bc63": {
            "_listId": "7",
            "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
            "author": "Adam Rubin.",
            "book_image": "https://storage.googleapis.com/du-prd/books/images/9780803736801.jpg",
            "_createdOn": "2023-07-12 22:06:27",
            "description": "What to serve your dragon-guests.",
            "title": "DRAGONS LOVE TACOS",
          },
          "e42bd6ff-8143-53b3-b574-c80553973559": {
            "_listId": "7",
            "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
            "author": "Drew Daywalt.",
            "book_image": "https://storage.googleapis.com/du-prd/books/images/9780399255373.jpg",
            "_createdOn": "2023-07-12 22:06:27",
            "description": "Problems arise when Duncan’s crayons revolt.",
            "title": "THE DAY THE CRAYONS QUIT",
          },
          "835b0f5f-fb74-5a99-9129-05012948ea7d": {
            "_listId": "7",
            "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
            "author": "Drew Daywalt.",
            "book_image": "https://storage.googleapis.com/du-prd/books/images/9780593621110.jpg",
            "_createdOn": "2023-07-12 22:06:27",
            "description": "The crayons go back to school and can't wait for art class.",
            "title": "THE CRAYONS GO BACK TO SCHOOL",
          },
          "0eda57dd-50e7-5233-8580-dc36e4b4b312": {
            "_listId": "10",
            "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
            "author": "Jenny Han",
            "book_image": "https://storage.googleapis.com/du-prd/books/images/9781416995586.jpg",
            "_createdOn": "2023-07-12 22:06:22",
            "description": "A beach house, summer love and enduring friendships.",
            "title": "THE SUMMER I TURNED PRETTY TRILOGY",
          },
          "494423b3-84b1-5f41-ae97-b525e4a5245c": {
            "_listId": "10",
            "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
            "author": "Holly Jackson",
            "book_image": "https://storage.googleapis.com/du-prd/books/images/9780593379851.jpg",
            "_createdOn": "2023-07-12 22:06:22",
            "description": "Pippa Fitz-Amobi solves murderous crimes.",
            "title": "A GOOD GIRL'S GUIDE TO MURDER",
          },
          "cb1d1f95-72fb-51ba-a5d1-fb54457d7ad9": {
            "_listId": "10",
            "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
            "author": "and   Jeff Kinney",
            "book_image": "https://storage.googleapis.com/du-prd/books/images/9781419711329.jpg",
            "_createdOn": "2023-07-12 22:06:22",
            "description": "The travails and challenges of adolescence.",
            "title": "DIARY OF A WIMPY KID",
          },
          "9df40295-9d1e-5ee8-ba89-ba22d2992500": {
            "_listId": "10",
            "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
            "author": "J.K. Rowling",
            "book_image": "https://storage.googleapis.com/du-prd/books/images/9780590353427.jpg",
            "_createdOn": "2023-07-12 22:06:22",
            "description": "A wizard hones his conjuring skills in the service of fighting evil.",
            "title": "HARRY POTTER",
          },
          "6023bfea-e267-5aca-8a56-2af3eba0439e": {
            "_listId": "10",
            "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
            "author": "Suzanne Collins",
            "book_image": "https://storage.googleapis.com/du-prd/books/images/9780545663267.jpg",
            "_createdOn": "2023-07-12 22:06:22",
            "description": "In a dystopia, a girl fights for survival on live TV.",
            "title": "THE HUNGER GAMES",
          },
          "e2abd326-9377-54d9-bf9c-5125478dd1c1": {
            "_listId": "10",
            "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
            "author": "Jennifer Lynn Barnes",
            "book_image": "https://storage.googleapis.com/du-prd/books/images/9780316370950.jpg",
            "_createdOn": "2023-07-12 22:06:22",
            "description": "Avery Grambs tries to figure out why an inheritance from a stranger was bestowed upon her.",
            "title": "THE INHERITANCE GAMES",
          },
          "5c1b7a21-c152-51d2-af9e-fb641e4f90e5": {
            "_listId": "14",
            "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
            "author": "Alice Oseman",
            "book_image": "https://storage.googleapis.com/du-prd/books/images/9781339016238.jpg",
            "_createdOn": "2023-07-12 22:06:23",
            "description": "Tori Spring is determined to find out who's behind the blog called Solitaire, which has caused serious pranks at her school.",
            "title": "SOLITAIRE",
          },
          "19555aab-32c6-52d2-9781-310810d0dd6f": {
            "_listId": "14",
            "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
            "author": "Holly Jackson",
            "book_image": "https://storage.googleapis.com/du-prd/books/images/9780593374160.jpg",
            "_createdOn": "2023-07-12 22:06:23",
            "description": "Six friends on a spring break road trip in an R.V. are the target of a sniper.",
            "title": "FIVE SURVIVE",
          },
          "bcf57ebd-38b2-59ea-bb70-bd09334e117e": {
            "_listId": "14",
            "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
            "author": "Alice Oseman",
            "book_image": "https://storage.googleapis.com/du-prd/books/images/9781338885101.jpg",
            "_createdOn": "2023-07-12 22:06:23",
            "description": "Nick and Charlie question whether their love is strong enough to survive being apart when Nick leaves for university.",
            "title": "NICK AND CHARLIE",
          },
          "0f81d9c3-b905-51f8-bba7-6f3c5610603c": {
            "_listId": "14",
            "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
            "author": "Adam Silvera",
            "book_image": "https://storage.googleapis.com/du-prd/books/images/9780063240803.jpg",
            "_createdOn": "2023-07-12 22:06:23",
            "description": "In this prequel to \"They Both Die at the End,\" Orion and Valentino attend the premiere of Death-Cast in Times Square.",
            "title": "THE FIRST TO DIE AT THE END",
          },
          "4e2ba9dd-e1e3-510d-9830-66259b3e98ec": {
            "_listId": "14",
            "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
            "author": "Rebecca Ross",
            "book_image": "https://storage.googleapis.com/du-prd/books/images/9781250857439.jpg",
            "_createdOn": "2023-07-12 22:06:23",
            "description": "Two young rival journalists find love through a magical connection.",
            "title": "DIVINE RIVALS",
          },
          "cb07c027-bf37-5272-8b11-cbe124f7b724": {
            "_listId": "14",
            "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
            "author": "Hayley Kiyoko",
            "book_image": "https://storage.googleapis.com/du-prd/books/images/9781250817631.jpg",
            "_createdOn": "2023-07-12 22:06:23",
            "description": "Two girls struggle with their feelings for each other.",
            "title": "GIRLS LIKE GIRLS",
          },
          "a7229ef2-7522-5cb7-86c4-024aca7420e7": {
            "_listId": "301",
            "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
            "author": "Bonnie Garmus",
            "book_image": "https://storage.googleapis.com/du-prd/books/images/9780385547345.jpg",
            "_createdOn": "2023-07-05 23:06:11",
            "description": "A scientist and single mother living in California in the 1960s becomes a star on a TV cooking show. Read by Miranda Raison, Pandora Sykes and the author. 11 hours, 55 minutes unabridged.",
            "title": "LESSONS IN CHEMISTRY",
          },
          "fb6b3476-1860-5b9d-8df2-4d06d0e54d05": {
            "_listId": "301",
            "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
            "author": "Rebecca Yarros",
            "book_image": "https://storage.googleapis.com/du-prd/books/images/9781649374042.jpg",
            "_createdOn": "2023-07-05 23:06:11",
            "description": "Violet Sorrengail is urged by the commanding general, who also is her mother, to become a candidate for the elite dragon riders. Read by Rebecca Soler and Teddy Hamilton. 20 hours, 47 minutes unabridged.",
            "title": "FOURTH WING",
          },
          "7cd90059-ec8b-53ae-8a5d-6697b3c191c7": {
            "_listId": "301",
            "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
            "author": "Nora Roberts",
            "book_image": "https://storage.googleapis.com/du-prd/books/images/9781250284112.jpg",
            "_createdOn": "2023-07-05 23:06:11",
            "description": "After her roommate is killed by a con artist, a former Army brat builds a new life at her mother's home in Vermont. Read by January LaVoy. 15 hours, 4 minutes unabridged.",
            "title": "IDENTITY",
          },
          "5fffb595-5d46-51f5-a683-449ac9645e64": {
            "_listId": "301",
            "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
            "author": "Abraham Verghese",
            "book_image": "https://storage.googleapis.com/du-prd/books/images/9780802162175.jpg",
            "_createdOn": "2023-07-05 23:06:11",
            "description": "Three generations of a family living on South India’s Malabar Coast suffer the loss of a family member by drowning. Read by the author. 31 hours, 16 minutes unabridged.",
            "title": "THE COVENANT OF WATER",
          },
          "967e65c2-3fb5-5bca-b194-231600bef6f5": {
            "_listId": "301",
            "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
            "author": "Barbara Kingsolver",
            "book_image": "https://storage.googleapis.com/du-prd/books/images/9780063251922.jpg",
            "_createdOn": "2023-07-05 23:06:11",
            "description": "Winner of a 2023 Pulitzer Prize for fiction. A reimagining of Charles Dickens’s “David Copperfield” set in the mountains of southern Appalachia. Read by Charlie Thurston. 21 hours, 3 minutes unabridged.",
            "title": "DEMON COPPERHEAD",
          },
          "3859f509-d661-538e-ac0b-86df6f89e208": {
            "_listId": "301",
            "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
            "author": "Elin Hilderbrand",
            "book_image": "https://storage.googleapis.com/du-prd/books/images/9780316258777.jpg",
            "_createdOn": "2023-07-05 23:06:11",
            "description": "After a tragedy, a popular food blogger brings friends from distinct times in her life to spend a weekend in Nantucket. Read by Erin Bennett. 12 hours, 45 minutes unabridged.",
            "title": "THE FIVE-STAR WEEKEND",
          },
          "e093216d-a3f3-5b3b-8bee-fea6808cabb8": {
            "_listId": "302",
            "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
            "author": "Peter Attia with Bill Gifford",
            "book_image": "https://storage.googleapis.com/du-prd/books/images/9780593236598.jpg",
            "_createdOn": "2023-07-05 23:06:04",
            "description": "A look at recent scientific research on aging and longevity. Read by Peter Attia. 17 hours, 8 minutes unabridged.",
            "title": "OUTLIVE",
          },
          "dade20d6-b303-510c-9687-48eab9308755": {
            "_listId": "302",
            "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
            "author": "Jennette McCurdy",
            "book_image": "https://storage.googleapis.com/du-prd/books/images/9781982185824.jpg",
            "_createdOn": "2023-07-05 23:06:04",
            "description": "The actress and filmmaker describes her eating disorders and difficult relationship with her mother. Read by the author. 6 hours, 25 minutes unabridged.",
            "title": "I'M GLAD MY MOM DIED",
          },
          "80848bc3-eb06-5a8f-a71e-9fe50bfba233": {
            "_listId": "302",
            "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
            "author": "Elliot Page",
            "book_image": "https://storage.googleapis.com/du-prd/books/images/9781250878359.jpg",
            "_createdOn": "2023-07-05 23:06:04",
            "description": "The Oscar-nominated star details discovering himself as a trans person and navigating abuse in Hollywood. Read by the author. 8 hours, 23 minutes unabridged.",
            "title": "PAGEBOY",
          },
          "cdd69a90-455d-5194-8060-86c0df2ea509": {
            "_listId": "302",
            "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
            "author": "Matthew McConaughey",
            "book_image": "https://storage.googleapis.com/du-prd/books/images/9780593139134.jpg",
            "_createdOn": "2023-07-05 23:06:04",
            "description": "The Academy Award-winning actor shares snippets from the diaries he kept over 35 years. Read by the author. 6 hours, 42 minutes unabridged.",
            "title": "GREENLIGHTS",
          },
          "50093459-fb0d-54bc-a8b3-0091663acaa0": {
            "_listId": "302",
            "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
            "author": "Robert F. Kennedy Jr",
            "book_image": "https://storage.googleapis.com/du-prd/books/images/9781510766808.jpg",
            "_createdOn": "2023-07-05 23:06:04",
            "description": "The anti-vaccine advocate gives his take on the former chief medical advisor to the president. Read by Bruce Wagner. 27 hours, 20 minutes unabridged.",
            "title": "THE REAL ANTHONY FAUCI",
          },
          "0db35be1-02f0-5fe8-8fdc-d4a669b5852f": {
            "_listId": "302",
            "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
            "author": "Prince Harry",
            "book_image": "https://storage.googleapis.com/du-prd/books/images/9780593593806.jpg",
            "_createdOn": "2023-07-05 23:06:04",
            "description": "The Duke of Sussex details his struggles with the royal family, loss of his mother, service in the British Army and marriage to Meghan Markle. Read by the author. 15 hours, 39 minutes unabridged.",
            "title": "SPARE",
          },
          "0398a355-c032-534e-a0af-647b06f0840d": {
            "_listId": "532",
            "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
            "author": "James Clear",
            "book_image": "https://storage.googleapis.com/du-prd/books/images/9780735211292.jpg",
            "_createdOn": "2023-07-05 23:06:13",
            "description": "",
            "title": "ATOMIC HABITS",
          },
          "da28ca16-1ebd-55aa-aba3-fde278604a82": {
            "_listId": "532",
            "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
            "author": "Rick Rubin with Neil Strauss",
            "book_image": "https://storage.googleapis.com/du-prd/books/images/9780593652886.jpg",
            "_createdOn": "2023-07-05 23:06:13",
            "description": "",
            "title": "THE CREATIVE ACT",
          },
          "b0fe54f6-2468-55d3-bedf-0338f98478e6": {
            "_listId": "532",
            "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
            "author": "Ramit Sethi",
            "book_image": "https://storage.googleapis.com/du-prd/books/images/9781523507870.jpg",
            "_createdOn": "2023-07-05 23:06:13",
            "description": "",
            "title": "I WILL TEACH YOU TO BE RICH, SECOND EDITION",
          },
          "4d35910f-8a4f-54f7-a63c-27748e8b5399": {
            "_listId": "532",
            "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
            "author": "William H. McRaven",
            "book_image": "https://storage.googleapis.com/du-prd/books/images/9781538707944.jpg",
            "_createdOn": "2023-07-05 23:06:13",
            "description": "",
            "title": "THE WISDOM OF THE BULLFROG",
          },
          "e9569270-fe3a-5fe4-a068-7eca3da622e7": {
            "_listId": "532",
            "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
            "author": "Brené Brown",
            "book_image": "https://storage.googleapis.com/du-prd/books/images/9780399592522.jpg",
            "_createdOn": "2023-07-05 23:06:13",
            "description": "",
            "title": "DARE TO LEAD",
          },
          "1e1ffccd-d526-5154-84de-1628b31454e9": {
            "_listId": "532",
            "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
            "author": "Daniel Kahneman",
            "book_image": "https://storage.googleapis.com/du-prd/books/images/9781429969352.jpg",
            "_createdOn": "2023-07-05 23:06:14",
            "description": "",
            "title": "THINKING, FAST AND SLOW",
          },
          "38aa45cc-2c25-57e9-9150-beae0acea89e": {
            "_listId": "719",
            "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
            "author": "Dav Pilkey",
            "book_image": "https://storage.googleapis.com/du-prd/books/images/9781338801910.jpg",
            "_createdOn": "2023-07-05 23:06:06",
            "description": "The 11th book in the Dog Man series. Piggy returns and the Supa Buddies are sabotaged.",
            "title": "TWENTY THOUSAND FLEAS UNDER THE SEA",
          },
          "30ca1735-594d-5fb6-a065-cb9306f2071a": {
            "_listId": "719",
            "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
            "author": "Rachel Smythe",
            "book_image": "https://storage.googleapis.com/du-prd/books/images/9780593599044.jpg",
            "_createdOn": "2023-07-05 23:06:06",
            "description": "As gossip about them swirls, Persephone and Hades choose to take a break to focus on their own issues.",
            "title": "LORE OLYMPUS, VOL. 4",
          },
          "72d9402f-c6f0-505b-be12-c74c7b8646f5": {
            "_listId": "719",
            "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
            "author": "FGTeeV.",
            "book_image": "https://storage.googleapis.com/du-prd/books/images/9780063260504.jpg",
            "_createdOn": "2023-07-05 23:06:06",
            "description": "The FGTeeV family encounter a T-Rex, a knight and angry space invaders.",
            "title": "FGTEEV: OUT OF TIME!",
          },
          "82b8b5ef-13af-5d86-980b-cd84e69bffe1": {
            "_listId": "719",
            "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
            "author": "Dav Pilkey",
            "book_image": "https://storage.googleapis.com/du-prd/books/images/9781338846621.jpg",
            "_createdOn": "2023-07-05 23:06:06",
            "description": "The fourth book in the Cat Kid Comic Club series. After doing their chores, baby frogs work together to create more mini-comics.",
            "title": "COLLABORATIONS",
          },
          "3c8b48b0-ff27-5880-bed1-31f146d58c82": {
            "_listId": "719",
            "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
            "author": "Ann M. Martin.",
            "book_image": "https://storage.googleapis.com/du-prd/books/images/9781338616101.jpg",
            "_createdOn": "2023-07-05 23:06:06",
            "description": "The 13th book in the Baby-sitters Club graphic novel series. Mary Anne receives a bad-luck charm in the mail with instructions to wear it.",
            "title": "MARY ANNE'S BAD LUCK MYSTERY",
          },
          "b0d57bad-c889-5e85-bccd-7ea1f7df7bff": {
            "_listId": "719",
            "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
            "author": "Dav Pilkey",
            "book_image": "https://storage.googleapis.com/du-prd/books/images/9781338535624.jpg",
            "_createdOn": "2023-07-05 23:06:06",
            "description": "The ninth book in the Dog Man series. After turning in his badge, the canine cop is determined not to just roll over.",
            "title": "GRIME AND PUNISHMENT",
          },
          "1d13b23f-da08-5fa6-992b-7108b3968bef": {
            "_listId": "10018",
            "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
            "author": "John Grisham",
            "book_image": "https://storage.googleapis.com/du-prd/books/images/9780385549325.jpg",
            "_createdOn": "2023-07-05 23:06:16",
            "description": "Three novellas: “Homecoming,” “Strawberry Moon” and “Sparring Partners.”",
            "title": "SPARRING PARTNERS",
          },
          "19171670-8823-526e-bb46-8cca2339962f": {
            "_listId": "10018",
            "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
            "author": "Danielle Steel",
            "book_image": "https://storage.googleapis.com/du-prd/books/images/9781984821614.jpg",
            "_createdOn": "2023-07-05 23:06:16",
            "description": "Parents of children who have gone missing on a dangerous peak in Montana form a search-and-rescue mission.",
            "title": "THE CHALLENGE",
          },
          "c2496368-e2ff-5420-a60f-e246ed19ddb5": {
            "_listId": "10018",
            "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
            "author": "Liane Moriarty",
            "book_image": "https://storage.googleapis.com/du-prd/books/images/9781250220257.jpg",
            "_createdOn": "2023-07-05 23:06:16",
            "description": "The Delaney siblings suspect their father of causing the disappearance of their mother.",
            "title": "APPLES NEVER FALL",
          },
          "a4906c3b-1e9c-5855-9abb-7ea8aff4b7cb": {
            "_listId": "10018",
            "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
            "author": "Nora Roberts",
            "book_image": "https://storage.googleapis.com/du-prd/books/images/9781250890078.jpg",
            "_createdOn": "2023-07-05 23:06:16",
            "description": "Two thrillers: “The Art of Deception” and “Risky Business.”",
            "title": "DANGER ZONE",
          },
          "ed212151-6693-5058-a421-a1ea23c8531c": {
            "_listId": "10018",
            "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
            "author": "Lisa Jackson",
            "book_image": "https://storage.googleapis.com/du-prd/books/images/9780758225658.jpg",
            "_createdOn": "2023-07-05 23:06:16",
            "description": "Called to investigate a murder, the New Orleans detective Reuben Montoya discovers that the victim — found on a cathedral altar in a yellowed bridal gown — is an old high school friend.",
            "title": "DEVIOUS",
          },
          "928da6ef-d332-5d60-904b-9e18cf9ad0f1": {
            "_listId": "10018",
            "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
            "author": "William W. Johnstone and J.A. Johnstone",
            "book_image": "https://storage.googleapis.com/du-prd/books/images/9780786049851.jpg",
            "_createdOn": "2023-07-05 23:06:16",
            "description": "The fifth book in the Smoke Jensen Novel of the West series. Jensen goes after the outlaws who attacked his friend.",
            "title": "DESOLATION CREEK",
          },
          "82d77c01-610e-563e-8f14-073084cd4a58": {
            "_listId": "10015",
            "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
            "author": "Sharon M. Draper",
            "book_image": "https://storage.googleapis.com/du-prd/books/images/9781416971719.jpg",
            "_createdOn": "2023-07-05 23:06:01",
            "description": "",
            "title": "OUT OF MY MIND",
          },
          "33e0a0a4-8158-58ef-9e88-1c49b4167580": {
            "_listId": "10015",
            "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
            "author": "Gordon Korman",
            "book_image": "https://storage.googleapis.com/du-prd/books/images/9781338053807.jpg",
            "_createdOn": "2023-07-05 23:06:01",
            "description": "",
            "title": "RESTART",
          },
          "58650411-6a43-5082-89a6-9e2c62832d2f": {
            "_listId": "10015",
            "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
            "author": "Peter Brown",
            "book_image": "https://storage.googleapis.com/du-prd/books/images/9780316381994.jpg",
            "_createdOn": "2023-07-05 23:06:02",
            "description": "",
            "title": "THE WILD ROBOT",
          },
          "72728168-095d-521b-90d2-2380bdc74220": {
            "_listId": "10015",
            "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
            "author": "Linda Sue Park",
            "book_image": "https://storage.googleapis.com/du-prd/books/images/9780547577319.jpg",
            "_createdOn": "2023-07-05 23:06:02",
            "description": "",
            "title": "A LONG WALK TO WATER",
          },
          "46604242-8624-57d1-bdd4-424c21cde273": {
            "_listId": "10015",
            "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
            "author": "Barbara O'Connor",
            "book_image": "https://storage.googleapis.com/du-prd/books/images/9781250144058.jpg",
            "_createdOn": "2023-07-05 23:06:02",
            "description": "",
            "title": "WISH",
          },
          "bcd9be95-b252-588a-a9a8-f2aef2f3be6a": {
            "_listId": "10015",
            "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
            "author": "Lynda Mullaly Hunt",
            "book_image": "https://storage.googleapis.com/du-prd/books/images/9780399162596.jpg",
            "_createdOn": "2023-07-05 23:06:02",
            "description": "",
            "title": "FISH IN A TREE",
          },
          "06b8daaf-e835-5d8a-b7fc-fc6ad002bef2": {
            "_listId": "10016",
            "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
            "author": "Laura Nowlin",
            "book_image": "https://storage.googleapis.com/du-prd/books/images/9781402277832.jpg",
            "_createdOn": "2023-07-05 23:06:08",
            "description": "",
            "title": "IF HE HAD BEEN WITH ME",
          },
          "14805c1f-c503-550e-912c-f90aa1507d04": {
            "_listId": "10016",
            "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
            "author": "K.L. Walther",
            "book_image": "https://storage.googleapis.com/du-prd/books/images/9781728210292.jpg",
            "_createdOn": "2023-07-05 23:06:09",
            "description": "",
            "title": "THE SUMMER OF BROKEN RULES",
          },
          "4c61a5f1-f0f8-5184-978c-c7056c96a644": {
            "_listId": "10016",
            "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
            "author": "Kathleen Glasgow",
            "book_image": "https://storage.googleapis.com/du-prd/books/images/9781101934715.jpg",
            "_createdOn": "2023-07-05 23:06:09",
            "description": "",
            "title": "GIRL IN PIECES",
          },
          "1bf449fc-40e6-556e-8e7a-f4dc8ea61c3a": {
            "_listId": "10016",
            "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
            "author": "Lynn Painter",
            "book_image": "https://storage.googleapis.com/du-prd/books/images/9781534467637.jpg",
            "_createdOn": "2023-07-05 23:06:09",
            "description": "",
            "title": "BETTER THAN THE MOVIES",
          },
          "bc9d9c11-51e8-5885-9239-fa84b126632d": {
            "_listId": "10016",
            "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
            "author": "Amber Smith",
            "book_image": "https://storage.googleapis.com/du-prd/books/images/9781481449359.jpg",
            "_createdOn": "2023-07-05 23:06:09",
            "description": "",
            "title": "THE WAY I USED TO BE",
          },
          "5b772e31-054a-5d90-9744-632244a74f22": {
            "_listId": "10016",
            "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
            "author": "Karen M. McManus",
            "book_image": "https://storage.googleapis.com/du-prd/books/images/9781524714680.jpg",
            "_createdOn": "2023-07-05 23:06:09",
            "description": "",
            "title": "ONE OF US IS LYING",
          }
        
      },
      shelves: {
        "id1": {
          "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8", 
          "listId": "10015",
          "bookId": "82d77c01-610e-563e-8f14-073084cd4a58",
          "shelf": "want",
          "_createdOn": "1690797112222"
        },
        "id2": {
          "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
          "listId": "10015",
          "bookId": "33e0a0a4-8158-58ef-9e88-1c49b4167580",
          "shelf": "currently",
          "_createdOn": "1690797111111"
        },
        "id3": {
          "_ownerId": "60f0cf0b-34b0-4abd-9769-8c42f830dffc",
          "listId": "10015",
          "bookId": "33e0a0a4-8158-58ef-9e88-1c49b4167580",
          "shelf": "want",
          "_createdOn": "1690797110385"
        },
        "cf6102d6-b947-465a-a10c-31bda6dca302": {
          "_ownerId": "847ec027-f659-4086-8032-5173e2f9c93a",
          "listId": "17",
          "bookId": "e2a3545e-e9cb-5828-9d97-50a798a0e4f6",
          "shelf": "want",
          "_createdOn": "1690797110384"
        },
        "4f7294ee-2749-469a-a35f-7a31d6d70402": {
          "_ownerId": "847ec027-f659-4086-8032-5173e2f9c93a",
          "listId": "13",
          "bookId": "ae6bd2cf-a5d7-535a-99dd-ca8e283c2b01",
          "shelf": "currently",
          "_createdOn": "1690797133797"
        },
        "08c655ce-09ef-4455-ac95-7a5b926b110d": {
          "_ownerId": "847ec027-f659-4086-8032-5173e2f9c93a",
          "listId": "302",
          "bookId": "80848bc3-eb06-5a8f-a71e-9fe50bfba233",
          "shelf": "read",
          "_createdOn": "1690797141386"
        },
        "1f69be46-e189-4728-b0f0-b8f2abe718ae": {
          "_ownerId": "847ec027-f659-4086-8032-5173e2f9c93a",
          "listId": "24",
          "bookId": "b98f7ad9-aa29-5b5d-bee0-1aae5a523991",
          "shelf": "read",
          "_createdOn": "1690797147972"
        },
        "097c3ebd-31ea-4dff-bec2-6d75e66e8bbd": {
          "_ownerId": "847ec027-f659-4086-8032-5173e2f9c93a",
          "listId": "10016",
          "bookId": "14805c1f-c503-550e-912c-f90aa1507d04",
          "shelf": "want",
          "_createdOn": "1690797153760"
        },
        "2931192a-cac2-4e7d-8e37-2e4414b8fa53": {
          "_ownerId": "455b415d-ce09-4895-986e-b8ce1a799a48",
          "listId": "1",
          "bookId": "dd6e4f9d-d082-552d-b888-7276a25b5aca",
          "shelf": "want",
          "_createdOn": "1690798247197"
        },
        "6b1834c6-2eeb-4ab6-aba8-c04cdc5dd9ca": {
          "_ownerId": "455b415d-ce09-4895-986e-b8ce1a799a48",
          "listId": "532",
          "bookId": "0398a355-c032-534e-a0af-647b06f0840d",
          "shelf": "want",
          "_createdOn": "1690798252021"
        },
        "3196de95-0708-40e1-bba6-c18addcfa434": {
          "_ownerId": "455b415d-ce09-4895-986e-b8ce1a799a48",
          "listId": "532",
          "bookId": "e9569270-fe3a-5fe4-a068-7eca3da622e7",
          "shelf": "want",
          "_createdOn": "1690798256806"
        },
        "68aafa9d-8df5-46db-84a9-e6697e7698c7": {
          "_ownerId": "455b415d-ce09-4895-986e-b8ce1a799a48",
          "listId": "13",
          "bookId": "8384c64a-d0de-5285-9132-8f16cc7b085f",
          "shelf": "currently",
          "_createdOn": "1690798289537"
        },
        "ff7354ff-ea5c-4c5a-a6bf-98b6b80767df": {
          "_ownerId": "455b415d-ce09-4895-986e-b8ce1a799a48",
          "listId": "17",
          "bookId": "0962ac94-2f91-5500-bcf8-24c90607bc4a",
          "shelf": "read",
          "_createdOn": "1690798296044"
        },
        "ed938d81-a361-44cf-989d-80f67db5e1a4": {
          "_ownerId": "455b415d-ce09-4895-986e-b8ce1a799a48",
          "listId": "301",
          "bookId": "7cd90059-ec8b-53ae-8a5d-6697b3c191c7",
          "shelf": "read",
          "_createdOn": "1690798306393"
        },
        "ee352e72-21c6-4333-9e40-aea2dcc0bfe4": {
          "_ownerId": "847ec027-f659-4086-8032-5173e2f9c93a",
          "listId": "302",
          "bookId": "e093216d-a3f3-5b3b-8bee-fea6808cabb8",
          "shelf": "want",
          "_createdOn": "1690798247198"
        },
        "94db339a-879f-45ff-ab34-9d57c78c1a5e": {
          "_ownerId": "847ec027-f659-4086-8032-5173e2f9c93a",
          "listId": "10016",
          "bookId": "bc9d9c11-51e8-5885-9239-fa84b126632d",
          "shelf": "want",
          "_createdOn": "1690798247199"
        },
        "435ae8a4-f8d9-4edd-9711-3c7d9c84cbed": {
          "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
          "listId": "719",
          "bookId": "30ca1735-594d-5fb6-a065-cb9306f2071a",
          "shelf": "want",
          "_createdOn": "1690800320878"
        },
        "b72d406a-84c4-4a99-aa92-048534f42e95": {
          "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
          "listId": "10018",
          "bookId": "a4906c3b-1e9c-5855-9abb-7ea8aff4b7cb",
          "shelf": "want",
          "_createdOn": "1690800333654"
        },
        "e4c90bee-c97a-4eed-a036-a9e8e07c3c37": {
          "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
          "listId": "302",
          "bookId": "cdd69a90-455d-5194-8060-86c0df2ea509",
          "shelf": "want",
          "_createdOn": "1690800339346"
        },
        "635fcb7a-78c8-48a7-bf1f-dcde206e57d4": {
          "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
          "listId": "13",
          "bookId": "ae6bd2cf-a5d7-535a-99dd-ca8e283c2b01",
          "shelf": "read",
          "_createdOn": "1690800352699"
        },
        "1342c6d9-e998-45ca-b0b9-3414629cb7a7": {
          "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
          "listId": "24",
          "bookId": "61980bbe-79bd-5824-9412-31c5f07762fd",
          "shelf": "read",
          "_createdOn": "1690800367074"
        },
        "d1dd249e-ffe3-4e49-a07f-662c4835498a": {
          "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
          "listId": "532",
          "bookId": "b0fe54f6-2468-55d3-bedf-0338f98478e6",
          "shelf": "read",
          "_createdOn": "1690800372294"
        },
      },
      usersInfo: {
    		"35c62d76-8152-4626-8712-eeb96381bea8": {
    			"email": "peter@abv.bg",
    			"hashedPassword": "83313014ed3e2391aa1332615d2f053cf5c1bfe05ca1cbcb5582443822df6eb1",
          "name": "Peter Petrov",
          "age": "31",
          "city": "Sofia",
          "img": "https://i.pinimg.com/originals/97/e4/2a/97e42a82fc7911961d3ca55f54d1372c.jpg",
          "_createdOn": "2023-07-12 22:06:27",
          "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8"
    		},
    		"847ec027-f659-4086-8032-5173e2f9c93a": {
    			"email": "george@abv.bg",
    			"hashedPassword": "83313014ed3e2391aa1332615d2f053cf5c1bfe05ca1cbcb5582443822df6eb1",
          "name": "George Georgiev",
          "age": "28",
          "city": "Ruse",
          "img": "https://www.clinicdermatech.com/images/men-service-face.jpg",
          "_createdOn": "2023-06-12 22:06:27",
          "_ownerId": "847ec027-f659-4086-8032-5173e2f9c93a"
    		},
    		"60f0cf0b-34b0-4abd-9769-8c42f830dffc": {
    			"email": "admin@abv.bg",
    			"hashedPassword": "83313014ed3e2391aa1332615d2f053cf5c1bfe05ca1cbcb5582443822df6eb1",
          "name": "Admin Adminov",
          "age": "33",
          "city": "Any",
          "img": "https://i.pinimg.com/originals/f6/a9/cf/f6a9cff61e65a034fce9b54420cc6ff5.jpg",
          "_createdOn": "2023-03-12 22:06:27",
          "_ownerId": "60f0cf0b-34b0-4abd-9769-8c42f830dffc"
    		},
        "0187ada9-de3c-44b6-9e3a-a10df426d5be": {
    			"email": "billgates@gmail.com",
    			"hashedPassword": "83313014ed3e2391aa1332615d2f053cf5c1bfe05ca1cbcb5582443822df6eb1",
          "name": "Bill Gates",
          "age": "67",
          "city": "Seattle",
          "img": "https://upload.wikimedia.org/wikipedia/commons/thumb/a/a8/Bill_Gates_2017_%28cropped%29.jpg/220px-Bill_Gates_2017_%28cropped%29.jpg",
          "_createdOn": "2023-07-12 20:08:47",
          "_ownerId": "455b415d-ce09-4895-986e-b8ce1a799a48",
    		}
    	},
      friends: {
        "7cb2f8ae-d7ea-4b12-a0a0-6a69079e71d4": {
          "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
          "friendId": "847ec027-f659-4086-8032-5173e2f9c93a",
          "_createdOn": "1690797057946",
        },
        "df6439a8-403e-4af6-bb0f-43af17ce608e": {
          "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
          "friendId": "0187ada9-de3c-44b6-9e3a-a10df426d5be",
          "_createdOn": "1690798701226",
        },
        "74519cb7-b4a7-441f-8e4d-f88961dae4d1": {
          "_ownerId": "847ec027-f659-4086-8032-5173e2f9c93a",
          "friendId": "35c62d76-8152-4626-8712-eeb96381bea8",
          "_createdOn": "1690800843125",
        },
        "fd3b2694-e04c-484e-b174-9a17ad0338b7": {
          "_ownerId": "847ec027-f659-4086-8032-5173e2f9c93a",
          "friendId": "0187ada9-de3c-44b6-9e3a-a10df426d5be",
          "_createdOn": "1690800921932",
        },
      },
      activities: {
        "001" : {
          "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
          "activity": "want",
          "listId": "10015",
          "bookId": "82d77c01-610e-563e-8f14-073084cd4a58",
          "_createdOn": "1690797112222"
        },
        "002" : {
          "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
          "activity": "currently",
          "listId": "10015",
          "bookId": "33e0a0a4-8158-58ef-9e88-1c49b4167580",
          "_createdOn": "1690797111111"
        },
        "003" : {
          "_ownerId": "60f0cf0b-34b0-4abd-9769-8c42f830dffc",
          "activity": "want",
          "listId": "10015",
          "bookId": "33e0a0a4-8158-58ef-9e88-1c49b4167580",
          "_createdOn": "1690797110385"
        },
        "004" : {
          "_ownerId": "847ec027-f659-4086-8032-5173e2f9c93a",
          "activity": "want",
          "listId": "17",
          "bookId": "e2a3545e-e9cb-5828-9d97-50a798a0e4f6",
          "_createdOn": "1690797110384"
        },
        "005" : {
          "_ownerId": "847ec027-f659-4086-8032-5173e2f9c93a",
          "activity": "currently",
          "listId": "13",
          "bookId": "ae6bd2cf-a5d7-535a-99dd-ca8e283c2b01",
          "_createdOn": "1690797133797"
        },
        "006" : {
          "_ownerId": "847ec027-f659-4086-8032-5173e2f9c93a",
          "activity": "read",
          "listId": "302",
          "bookId": "80848bc3-eb06-5a8f-a71e-9fe50bfba233",
          "_createdOn": "1690797141386"
        },
        "007" : {
          "_ownerId": "847ec027-f659-4086-8032-5173e2f9c93a",
          "activity": "read",
          "listId": "24",
          "bookId": "b98f7ad9-aa29-5b5d-bee0-1aae5a523991",
          "_createdOn": "1690797147972"
        },
        "008" : {
          "_ownerId": "847ec027-f659-4086-8032-5173e2f9c93a",
          "activity": "want",
          "listId": "10016",
          "bookId": "14805c1f-c503-550e-912c-f90aa1507d04",
          "_createdOn": "1690797153760"
        },
        "011" : {
          "_ownerId": "455b415d-ce09-4895-986e-b8ce1a799a48",
          "activity": "want",
          "listId": "1",
          "bookId": "dd6e4f9d-d082-552d-b888-7276a25b5aca",
          "_createdOn": "1690798247197"
        },
        "012" : {
          "_ownerId": "455b415d-ce09-4895-986e-b8ce1a799a48",
          "activity": "want",
          "listId": "532",
          "bookId": "0398a355-c032-534e-a0af-647b06f0840d",
          "_createdOn": "1690798252021"
        },
        "013" : {
          "_ownerId": "455b415d-ce09-4895-986e-b8ce1a799a48",
          "activity": "want",
          "listId": "532",
          "bookId": "e9569270-fe3a-5fe4-a068-7eca3da622e7",
          "_createdOn": "1690798256806"
        },
        "014" : {
          "_ownerId": "455b415d-ce09-4895-986e-b8ce1a799a48",
          "activity": "currently",
          "listId": "13",
          "bookId": "8384c64a-d0de-5285-9132-8f16cc7b085f",
          "_createdOn": "1690798289537"
        },
        "015" : {
          "_ownerId": "455b415d-ce09-4895-986e-b8ce1a799a48",
          "activity": "read",
          "listId": "17",
          "bookId": "0962ac94-2f91-5500-bcf8-24c90607bc4a",
          "_createdOn": "1690798296044"
        },
        "016" : {
          "_ownerId": "455b415d-ce09-4895-986e-b8ce1a799a48",
          "activity": "read",
          "listId": "301",
          "bookId": "7cd90059-ec8b-53ae-8a5d-6697b3c191c7",
          "_createdOn": "1690798306393"
        },
        "009" : {
          "_ownerId": "847ec027-f659-4086-8032-5173e2f9c93a",
          "activity": "want",
          "listId": "302",
          "bookId": "e093216d-a3f3-5b3b-8bee-fea6808cabb8",
          "_createdOn": "1690798247198"
        },
        "010" : {
          "_ownerId": "847ec027-f659-4086-8032-5173e2f9c93a",
          "activity": "want",
          "listId": "10016",
          "bookId": "bc9d9c11-51e8-5885-9239-fa84b126632d",
          "_createdOn": "1690798247199"
        },
        "3bbcbced-85c1-4258-8128-d7b5bda5c35f" : {
          "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
          "activity": "want",
          "listId": "719",
          "bookId": "30ca1735-594d-5fb6-a065-cb9306f2071a",
          "_createdOn": "1690800320893"
        },
        "15918a02-4c92-47ba-bbb1-a82c731025e6" : {
          "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
          "activity": "want",
          "listId": "10018",
          "bookId": "a4906c3b-1e9c-5855-9abb-7ea8aff4b7cb",
          "_createdOn": "1690800333664"
        },
        "b6ee367e-d10b-48dc-ba22-b819c30cc386" : {
          "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
          "activity": "want",
          "listId": "302",
          "bookId": "cdd69a90-455d-5194-8060-86c0df2ea509",
          "_createdOn": "1690800339359"
        },
        "18bb4f96-5434-4733-a173-c458c8dc37ac" : {
          "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
          "activity": "read",
          "listId": "13",
          "bookId": "ae6bd2cf-a5d7-535a-99dd-ca8e283c2b01",
          "_createdOn": "1690800352710"
        },
        "0830abf3-e0b3-491b-b690-fae2d95e9735" : {
          "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
          "activity": "read",
          "listId": "24",
          "bookId": "61980bbe-79bd-5824-9412-31c5f07762fd",
          "_createdOn": "1690800367085"
        },
        "e61279bc-cc3e-4f5c-a309-0ccd4ddc7794" : {
          "_ownerId": "35c62d76-8152-4626-8712-eeb96381bea8",
          "activity": "read",
          "listId": "532",
          "bookId": "b0fe54f6-2468-55d3-bedf-0338f98478e6",
          "_createdOn": "1690800372306"
        },
      },
    };
    var settings = {
    	identity: identity,
    	protectedData: protectedData,
    	seedData: seedData
    };

    const plugins = [
        storage(settings),
        auth(settings),
        util$2()
    ];

    const server = http__default['default'].createServer(requestHandler(plugins, services));

    const port = 3030;
    server.listen(port);
    console.log(`Server started on port ${port}. You can make requests to http://localhost:${port}/`);
    console.log(`Admin panel located at http://localhost:${port}/admin`);

    var softuniPracticeServer = {

    };

    return softuniPracticeServer;

})));
