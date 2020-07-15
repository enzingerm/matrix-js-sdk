/*
Copyright 2015, 2016 OpenMarket Ltd
Copyright 2017 Vector Creations Ltd
Copyright 2019 The Matrix.org Foundation C.I.C.
Copyright 2019 Michael Telatynski <7t3chguy@gmail.com>

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

/**
 * This is an internal module. MatrixBaseApis is currently only meant to be used
 * by {@link client~MatrixClient}.
 *
 * @module base-apis
 */

import {EventEmitter} from "events";
import {ServiceType} from './service-types';
import {logger} from './logger';
import {PushProcessor} from "./pushprocessor";
import * as utils from "./utils";
import {MatrixHttpApi, PREFIX_IDENTITY_V2, PREFIX_R0, PREFIX_UNSTABLE} from "./http-api";

interface IAuth {

}

interface IRegisterRequestData {
    auth: IAuth;
    username?: string;
    password?: string;
    bind_email?: boolean;
    bind_msisdn?: boolean;
    guest_access_token?: string;
    inhibit_login?: boolean;
    // Temporary parameter added to make the register endpoint advertise
    // msisdn flows. This exists because there are clients that break
    // when given stages they don't recognise. This parameter will cease
    // to be necessary once these old clients are gone.
    // Only send it if we send any params at all (the password param is
    // mandatory, so if we send any params, we'll send the password param)
    x_show_msisdn?: boolean
}

function termsUrlForService(serviceType: ServiceType, baseUrl: string) {
    switch (serviceType) {
        case ServiceType.IS:
            return baseUrl + PREFIX_IDENTITY_V2 + '/terms';
        case ServiceType.IM:
            return baseUrl + '/_matrix/integrations/v1/terms';
        default:
            throw new Error('Unsupported service type');
    }
}

// Low-level wrappers for the Matrix APIs
export abstract class MatrixBaseApis extends EventEmitter {
    public baseUrl: string;
    public idBaseUrl: string;
    public readonly identityServer: string;

    protected credentials: {
        userId: string;
    }

    private readonly http: MatrixHttpApi;
    private txnCtr = 0;

    /**
     * @constructor
     *
     * @param {Object} opts Configuration options
     *
     * @param {string} opts.baseUrl Required. The base URL to the client-server
     * HTTP API.
     *
     * @param {string} opts.idBaseUrl Optional. The base identity server URL for
     * identity server requests.
     *
     * @param {Function} opts.request Required. The function to invoke for HTTP
     * requests. The value of this property is typically <code>require("request")
     * </code> as it returns a function which meets the required interface. See
     * {@link requestFunction} for more information.
     *
     * @param {string} opts.accessToken The access_token for this user.
     *
     * @param {IdentityServerProvider} [opts.identityServer]
     * Optional. A provider object with one function `getAccessToken`, which is a
     * callback that returns a Promise<String> of an identity access token to supply
     * with identity requests. If the object is unset, no access token will be
     * supplied.
     * See also https://github.com/vector-im/riot-web/issues/10615 which seeks to
     * replace the previous approach of manual access tokens params with this
     * callback throughout the SDK.
     *
     * @param {Number=} opts.localTimeoutMs Optional. The default maximum amount of
     * time to wait before timing out HTTP requests. If not specified, there is no
     * timeout.
     *
     * @param {Object} opts.queryParams Optional. Extra query parameters to append
     * to all requests with this client. Useful for application services which require
     * <code>?user_id=</code>.
     *
     * @param {boolean} [opts.useAuthorizationHeader = false] Set to true to use
     * Authorization header instead of query param to send the access token to the server.
     */
    constructor(opts) {
        super();

        utils.checkObjectHasKeys(opts, ["baseUrl", "request"]);

        this.baseUrl = opts.baseUrl;
        this.idBaseUrl = opts.idBaseUrl;
        this.identityServer = opts.identityServer;

        const userId = (opts.userId || null);
        this.credentials = {userId};

        const httpOpts = {
            baseUrl: opts.baseUrl,
            idBaseUrl: opts.idBaseUrl,
            accessToken: opts.accessToken,
            request: opts.request,
            prefix: PREFIX_R0,
            onlyData: true,
            extraParams: opts.queryParams,
            localTimeoutMs: opts.localTimeoutMs,
            useAuthorizationHeader: opts.useAuthorizationHeader,
        };
        this.http = new MatrixHttpApi(this, httpOpts);
    }

    abstract isVersionSupported(version: string): Promise<boolean>;

    /**
     * Get the Homeserver URL of this client
     * @return {string} Homeserver URL of this client
     */
    getHomeserverUrl() {
        return this.baseUrl;
    }

    /**
     * Get the Identity Server URL of this client
     * @param {boolean} stripProto whether or not to strip the protocol from the URL
     * @return {string} Identity Server URL of this client
     */
    getIdentityServerUrl(stripProto = false) {
        if (stripProto && (this.idBaseUrl.startsWith("http://") ||
            this.idBaseUrl.startsWith("https://"))) {
            return this.idBaseUrl.split("://")[1];
        }
        return this.idBaseUrl;
    }

    /**
     * Set the Identity Server URL of this client
     * @param {string} url New Identity Server URL
     */
    setIdentityServerUrl(url) {
        this.idBaseUrl = utils.ensureNoTrailingSlash(url);
        this.http.setIdBaseUrl(this.idBaseUrl);
    }

    /**
     * Get the access token associated with this account.
     * @return {?String} The access_token or null
     */
    getAccessToken() {
        return this.http.opts.accessToken || null;
    }

    /**
     * @return {boolean} true if there is a valid access_token for this client.
     */
    isLoggedIn() {
        return this.http.opts.accessToken !== undefined;
    }

    /**
     * Make up a new transaction id
     *
     * @return {string} a new, unique, transaction id
     */
    makeTxnId() {
        return "m" + new Date().getTime() + "." + (this.txnCtr++);
    }


    // Registration/Login operations
    // =============================

    /**
     * Check whether a username is available prior to registration. An error response
     * indicates an invalid/unavailable username.
     * @param {string} username The username to check the availability of.
     * @return {Promise} Resolves: to `true`.
     */
    isUsernameAvailable(username) {
        return this.http.authedRequest(
            undefined, "GET", '/register/available', { username: username },
        ).then((response) => {
            return response.available;
        });
    }

    /**
     * @param {string} username
     * @param {string} password
     * @param {string} sessionId
     * @param {Object} auth
     * @param {Object} bindThreepids Set key 'email' to true to bind any email
     *     threepid uses during registration in the ID server. Set 'msisdn' to
     *     true to bind msisdn.
     * @param {string} guestAccessToken
     * @param {string} inhibitLogin
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: TODO
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    register(
        username, password,
        sessionId, auth, bindThreepids, guestAccessToken, inhibitLogin,
        callback,
    ) {
        // backwards compat
        if (bindThreepids === true) {
            bindThreepids = {email: true};
        } else if (bindThreepids === null || bindThreepids === undefined) {
            bindThreepids = {};
        }
        if (typeof inhibitLogin === 'function') {
            callback = inhibitLogin;
            inhibitLogin = undefined;
        }

        if (sessionId) {
            auth.session = sessionId;
        }

        const params: IRegisterRequestData = {
            auth: auth,
        };
        if (username !== undefined && username !== null) {
            params.username = username;
        }
        if (password !== undefined && password !== null) {
            params.password = password;
        }
        if (bindThreepids.email) {
            params.bind_email = true;
        }
        if (bindThreepids.msisdn) {
            params.bind_msisdn = true;
        }
        if (guestAccessToken !== undefined && guestAccessToken !== null) {
            params.guest_access_token = guestAccessToken;
        }
        if (inhibitLogin !== undefined && inhibitLogin !== null) {
            params.inhibit_login = inhibitLogin;
        }
        if (password !== undefined && password !== null) {
            params.x_show_msisdn = true;
        }

        return this.registerRequest(params, undefined, callback);
    }

    /**
     * Register a guest account.
     * @param {Object=} opts Registration options
     * @param {Object} opts.body JSON HTTP body to provide.
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: TODO
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    registerGuest(opts, callback) {
        opts = opts || {};
        opts.body = opts.body || {};
        return this.registerRequest(opts.body, "guest", callback);
    }

    /**
     * @param {Object} data   parameters for registration request
     * @param {string=} kind  type of user to register. may be "guest"
     * @param {module:client.callback=} callback
     * @return {Promise} Resolves: to the /register response
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    registerRequest(data, kind, callback) {
        return this.http.request(
            callback, "POST", "/register", { kind }, data,
        );
    }

    /**
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: TODO
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    loginFlows(callback) {
        return this.http.request(callback, "GET", "/login");
    }

    /**
     * @param {string} loginType
     * @param {Object} data
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: TODO
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    login(loginType, data, callback) {
        const login_data = {
            type: loginType,
        };

        // merge data into login_data
        utils.extend(login_data, data);

        return this.http.authedRequest(
            (error, response) => {
                if (response && response.access_token && response.user_id) {
                    this.http.opts.accessToken = response.access_token;
                    this.credentials = {
                        userId: response.user_id,
                    };
                }

                if (callback) {
                    callback(error, response);
                }
            }, "POST", "/login", undefined, login_data,
        );
    }

    /**
     * @param {string} user
     * @param {string} password
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: TODO
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    loginWithPassword(user, password, callback) {
        return this.login("m.login.password", {
            user: user,
            password: password,
        }, callback);
    }

    /**
     * @param {string} relayState URL Callback after SAML2 Authentication
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: TODO
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    loginWithSAML2(relayState, callback) {
        return this.login("m.login.saml2", {
            relay_state: relayState,
        }, callback);
    }

    /**
     * @param {string} redirectUrl The URL to redirect to after the HS
     * authenticates with CAS.
     * @return {string} The HS URL to hit to begin the CAS login process.
     */
    getCasLoginUrl(redirectUrl) {
        return this.getSsoLoginUrl(redirectUrl, "cas");
    }

    /**
     * @param {string} redirectUrl The URL to redirect to after the HS
     *     authenticates with the SSO.
     * @param {string} loginType The type of SSO login we are doing (sso or cas).
     *     Defaults to 'sso'.
     * @return {string} The HS URL to hit to begin the SSO login process.
     */
    getSsoLoginUrl(redirectUrl, loginType) {
        if (loginType === undefined) {
            loginType = "sso";
        }
        return this.http.getUrl(`/login/${loginType}/redirect`, {
            "redirectUrl": redirectUrl,
        }, PREFIX_R0);
    }

    /**
     * @param {string} token Login token previously received from homeserver
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: TODO
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    loginWithToken(token, callback) {
        return this.login("m.login.token", {
            token: token,
        }, callback);
    }


    /**
     * Logs out the current session.
     * Obviously, further calls that require authorisation should fail after this
     * method is called. The state of the MatrixClient object is not affected:
     * it is up to the caller to either reset or destroy the MatrixClient after
     * this method succeeds.
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: On success, the empty object
     */
    logout(callback) {
        return this.http.authedRequest(
            callback, "POST", '/logout',
        );
    }

    /**
     * Deactivates the logged-in account.
     * Obviously, further calls that require authorisation should fail after this
     * method is called. The state of the MatrixClient object is not affected:
     * it is up to the caller to either reset or destroy the MatrixClient after
     * this method succeeds.
     * @param {object} auth Optional. Auth data to supply for User-Interactive auth.
     * @param {boolean} erase Optional. If set, send as `erase` attribute in the
     * JSON request body, indicating whether the account should be erased. Defaults
     * to false.
     * @return {Promise} Resolves: On success, the empty object
     */
    deactivateAccount(auth, erase) {
        if (typeof(erase) === 'function') {
            throw new Error(
                'deactivateAccount no longer accepts a callback parameter',
            );
        }

        return this.http.authedRequest(
            undefined, "POST", '/account/deactivate', undefined, {auth, erase},
        );
    }

    /**
     * Get the fallback URL to use for unknown interactive-auth stages.
     *
     * @param {string} loginType     the type of stage being attempted
     * @param {string} authSessionId the auth session ID provided by the homeserver
     *
     * @return {string} HS URL to hit to for the fallback interface
     */
    getFallbackAuthUrl(loginType, authSessionId) {
        const path = utils.encodeUri("/auth/$loginType/fallback/web", {
            $loginType: loginType,
        });

        return this.http.getUrl(path, {
            session: authSessionId,
        }, PREFIX_R0);
    }

    // Room operations
    // ===============

    /**
     * Create a new room.
     * @param {Object} options a list of options to pass to the /createRoom API.
     * @param {string} options.room_alias_name The alias localpart to assign to
     * this room.
     * @param {string} options.visibility Either 'public' or 'private'.
     * @param {string[]} options.invite A list of user IDs to invite to this room.
     * @param {string} options.name The name to give this room.
     * @param {string} options.topic The topic to give this room.
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: <code>{room_id: {string},
     * room_alias: {string(opt)}}</code>
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    createRoom(options, callback) {
        // valid options include: room_alias_name, visibility, invite
        return this.http.authedRequest(
            callback, "POST", "/createRoom", undefined, options,
        );
    }
    /**
     * Fetches relations for a given event
     * @param {string} roomId the room of the event
     * @param {string} eventId the id of the event
     * @param {string} relationType the rel_type of the relations requested
     * @param {string} eventType the event type of the relations requested
     * @param {Object} opts options with optional values for the request.
     * @param {Object} opts.from the pagination token returned from a previous request as `next_batch` to return following relations.
     * @return {Object} the response, with chunk and next_batch.
     */
    async fetchRelations(roomId, eventId, relationType, eventType, opts) {
        const queryParams = {
            from: opts.from,
        };
        const queryString = utils.encodeParams(queryParams);
        const path = utils.encodeUri(
            "/rooms/$roomId/relations/$eventId/$relationType/$eventType?" + queryString, {
                $roomId: roomId,
                $eventId: eventId,
                $relationType: relationType,
                $eventType: eventType,
            });
        const response = await this.http.authedRequest(
            undefined, "GET", path, null, null, {
                prefix: PREFIX_UNSTABLE,
            },
        );
        return response;
    }

    /**
     * @param {string} roomId
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: TODO
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    roomState(roomId, callback) {
        const path = utils.encodeUri("/rooms/$roomId/state", {$roomId: roomId});
        return this.http.authedRequest(callback, "GET", path);
    }

    /**
     * Get an event in a room by its event id.
     * @param {string} roomId
     * @param {string} eventId
     * @param {module:client.callback} callback Optional.
     *
     * @return {Promise} Resolves to an object containing the event.
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    fetchRoomEvent(roomId, eventId, callback) {
        const path = utils.encodeUri(
            "/rooms/$roomId/event/$eventId", {
                $roomId: roomId,
                $eventId: eventId,
            },
        );
        return this.http.authedRequest(callback, "GET", path);
    }

    /**
     * @param {string} roomId
     * @param {string} includeMembership the membership type to include in the response
     * @param {string} excludeMembership the membership type to exclude from the response
     * @param {string} atEventId the id of the event for which moment in the timeline the members should be returned for
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: dictionary of userid to profile information
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    members(roomId, includeMembership, excludeMembership, atEventId, callback) {
        const queryParams = {
            membership: includeMembership ? includeMembership : undefined,
            not_membership: excludeMembership ? excludeMembership : undefined,
            at: atEventId ? atEventId : undefined,
        };

        const queryString = utils.encodeParams(queryParams);

        const path = utils.encodeUri("/rooms/$roomId/members?" + queryString,
            {$roomId: roomId});
        return this.http.authedRequest(callback, "GET", path);
    }

    /**
     * Upgrades a room to a new protocol version
     * @param {string} roomId
     * @param {string} newVersion The target version to upgrade to
     * @return {Promise} Resolves: Object with key 'replacement_room'
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    upgradeRoom(roomId, newVersion) {
        const path = utils.encodeUri("/rooms/$roomId/upgrade", {$roomId: roomId});
        return this.http.authedRequest(
            undefined, "POST", path, undefined, {new_version: newVersion},
        );
    }


    /**
     * @param {string} groupId
     * @return {Promise} Resolves: Group summary object
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    getGroupSummary(groupId) {
        const path = utils.encodeUri("/groups/$groupId/summary", {$groupId: groupId});
        return this.http.authedRequest(undefined, "GET", path);
    }

    /**
     * @param {string} groupId
     * @return {Promise} Resolves: Group profile object
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    getGroupProfile(groupId) {
        const path = utils.encodeUri("/groups/$groupId/profile", {$groupId: groupId});
        return this.http.authedRequest(undefined, "GET", path);
    }

    /**
     * @param {string} groupId
     * @param {Object} profile The group profile object
     * @param {string=} profile.name Name of the group
     * @param {string=} profile.avatar_url MXC avatar URL
     * @param {string=} profile.short_description A short description of the room
     * @param {string=} profile.long_description A longer HTML description of the room
     * @return {Promise} Resolves: Empty object
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    setGroupProfile(groupId, profile) {
        const path = utils.encodeUri("/groups/$groupId/profile", {$groupId: groupId});
        return this.http.authedRequest(
            undefined, "POST", path, undefined, profile,
        );
    }

    /**
     * @param {string} groupId
     * @param {object} policy The join policy for the group. Must include at
     *     least a 'type' field which is 'open' if anyone can join the group
     *     the group without prior approval, or 'invite' if an invite is
     *     required to join.
     * @return {Promise} Resolves: Empty object
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    setGroupJoinPolicy(groupId, policy) {
        const path = utils.encodeUri(
            "/groups/$groupId/settings/m.join_policy",
            {$groupId: groupId},
        );
        return this.http.authedRequest(
            undefined, "PUT", path, undefined, {
                'm.join_policy': policy,
            },
        );
    }

    /**
     * @param {string} groupId
     * @return {Promise} Resolves: Group users list object
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    getGroupUsers(groupId) {
        const path = utils.encodeUri("/groups/$groupId/users", {$groupId: groupId});
        return this.http.authedRequest(undefined, "GET", path);
    }

    /**
     * @param {string} groupId
     * @return {Promise} Resolves: Group users list object
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    getGroupInvitedUsers(groupId) {
        const path = utils.encodeUri("/groups/$groupId/invited_users", {
            $groupId: groupId,
        });
        return this.http.authedRequest(undefined, "GET", path);
    }

    /**
     * @param {string} groupId
     * @return {Promise} Resolves: Group rooms list object
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    getGroupRooms(groupId) {
        const path = utils.encodeUri("/groups/$groupId/rooms", {$groupId: groupId});
        return this.http.authedRequest(undefined, "GET", path);
    }

    /**
     * @param {string} groupId
     * @param {string} userId
     * @return {Promise} Resolves: Empty object
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    inviteUserToGroup(groupId, userId) {
        const path = utils.encodeUri(
            "/groups/$groupId/admin/users/invite/$userId",
            {$groupId: groupId, $userId: userId},
        );
        return this.http.authedRequest(undefined, "PUT", path, undefined, {});
    }

    /**
     * @param {string} groupId
     * @param {string} userId
     * @return {Promise} Resolves: Empty object
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    removeUserFromGroup(groupId, userId) {
        const path = utils.encodeUri(
            "/groups/$groupId/admin/users/remove/$userId",
            {$groupId: groupId, $userId: userId},
        );
        return this.http.authedRequest(undefined, "PUT", path, undefined, {});
    }

    /**
     * @param {string} groupId
     * @param {string} userId
     * @param {string} roleId Optional.
     * @return {Promise} Resolves: Empty object
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    addUserToGroupSummary(groupId, userId, roleId) {
        const path = utils.encodeUri(
            roleId ?
                "/groups/$groupId/summary/$roleId/users/$userId" :
                "/groups/$groupId/summary/users/$userId",
            {$groupId: groupId, $roleId: roleId, $userId: userId},
        );
        return this.http.authedRequest(undefined, "PUT", path, undefined, {});
    }

    /**
     * @param {string} groupId
     * @param {string} userId
     * @return {Promise} Resolves: Empty object
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    removeUserFromGroupSummary(groupId, userId) {
        const path = utils.encodeUri(
            "/groups/$groupId/summary/users/$userId",
            {$groupId: groupId, $userId: userId},
        );
        return this.http.authedRequest(undefined, "DELETE", path, undefined, {});
    }

    /**
     * @param {string} groupId
     * @param {string} roomId
     * @param {string} categoryId Optional.
     * @return {Promise} Resolves: Empty object
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    addRoomToGroupSummary(groupId, roomId, categoryId) {
        const path = utils.encodeUri(
            categoryId ?
                "/groups/$groupId/summary/$categoryId/rooms/$roomId" :
                "/groups/$groupId/summary/rooms/$roomId",
            {$groupId: groupId, $categoryId: categoryId, $roomId: roomId},
        );
        return this.http.authedRequest(undefined, "PUT", path, undefined, {});
    }

    /**
     * @param {string} groupId
     * @param {string} roomId
     * @return {Promise} Resolves: Empty object
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    removeRoomFromGroupSummary(groupId, roomId) {
        const path = utils.encodeUri(
            "/groups/$groupId/summary/rooms/$roomId",
            {$groupId: groupId, $roomId: roomId},
        );
        return this.http.authedRequest(undefined, "DELETE", path, undefined, {});
    }

    /**
     * @param {string} groupId
     * @param {string} roomId
     * @param {bool} isPublic Whether the room-group association is visible to non-members
     * @return {Promise} Resolves: Empty object
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    addRoomToGroup(groupId, roomId, isPublic) {
        if (isPublic === undefined) {
            isPublic = true;
        }
        const path = utils.encodeUri(
            "/groups/$groupId/admin/rooms/$roomId",
            {$groupId: groupId, $roomId: roomId},
        );
        return this.http.authedRequest(undefined, "PUT", path, undefined,
            { "m.visibility": { type: isPublic ? "public" : "private" } },
        );
    }

    /**
     * Configure the visibility of a room-group association.
     * @param {string} groupId
     * @param {string} roomId
     * @param {bool} isPublic Whether the room-group association is visible to non-members
     * @return {Promise} Resolves: Empty object
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    updateGroupRoomVisibility(groupId, roomId, isPublic) {
        // NB: The /config API is generic but there's not much point in exposing this yet as synapse
        //     is the only server to implement this. In future we should consider an API that allows
        //     arbitrary configuration, i.e. "config/$configKey".

        const path = utils.encodeUri(
            "/groups/$groupId/admin/rooms/$roomId/config/m.visibility",
            {$groupId: groupId, $roomId: roomId},
        );
        return this.http.authedRequest(undefined, "PUT", path, undefined,
            { type: isPublic ? "public" : "private" },
        );
    }

    /**
     * @param {string} groupId
     * @param {string} roomId
     * @return {Promise} Resolves: Empty object
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    removeRoomFromGroup(groupId, roomId) {
        const path = utils.encodeUri(
            "/groups/$groupId/admin/rooms/$roomId",
            {$groupId: groupId, $roomId: roomId},
        );
        return this.http.authedRequest(undefined, "DELETE", path, undefined, {});
    }

    /**
     * @param {string} groupId
     * @param {Object} opts Additional options to send alongside the acceptance.
     * @return {Promise} Resolves: Empty object
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    acceptGroupInvite(groupId, opts = null) {
        const path = utils.encodeUri(
            "/groups/$groupId/self/accept_invite",
            {$groupId: groupId},
        );
        return this.http.authedRequest(undefined, "PUT", path, undefined, opts || {});
    }

    /**
     * @param {string} groupId
     * @return {Promise} Resolves: Empty object
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    joinGroup(groupId) {
        const path = utils.encodeUri(
            "/groups/$groupId/self/join",
            {$groupId: groupId},
        );
        return this.http.authedRequest(undefined, "PUT", path, undefined, {});
    }

    /**
     * @param {string} groupId
     * @return {Promise} Resolves: Empty object
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    leaveGroup(groupId) {
        const path = utils.encodeUri(
            "/groups/$groupId/self/leave",
            {$groupId: groupId},
        );
        return this.http.authedRequest(undefined, "PUT", path, undefined, {});
    }

    /**
     * @return {Promise} Resolves: The groups to which the user is joined
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    getJoinedGroups() {
        const path = utils.encodeUri("/joined_groups");
        return this.http.authedRequest(undefined, "GET", path);
    }

    /**
     * @param {Object} content Request content
     * @param {string} content.localpart The local part of the desired group ID
     * @param {Object} content.profile Group profile object
     * @return {Promise} Resolves: Object with key group_id: id of the created group
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    createGroup(content) {
        const path = utils.encodeUri("/create_group");
        return this.http.authedRequest(
            undefined, "POST", path, undefined, content,
        );
    }

    /**
     * @param {string[]} userIds List of user IDs
     * @return {Promise} Resolves: Object as exmaple below
     *
     *     {
     *         "users": {
     *             "@bob:example.com": {
     *                 "+example:example.com"
     *             }
     *         }
     *     }
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    getPublicisedGroups(userIds) {
        const path = utils.encodeUri("/publicised_groups");
        return this.http.authedRequest(
            undefined, "POST", path, undefined, { user_ids: userIds },
        );
    }

    /**
     * @param {string} groupId
     * @param {bool} isPublic Whether the user's membership of this group is made public
     * @return {Promise} Resolves: Empty object
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    setGroupPublicity(groupId, isPublic) {
        const path = utils.encodeUri(
            "/groups/$groupId/self/update_publicity",
            {$groupId: groupId},
        );
        return this.http.authedRequest(undefined, "PUT", path, undefined, {
            publicise: isPublic,
        });
    }

    /**
     * Retrieve a state event.
     * @param {string} roomId
     * @param {string} eventType
     * @param {string} stateKey
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: TODO
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    getStateEvent(roomId, eventType, stateKey, callback) {
        const pathParams = {
            $roomId: roomId,
            $eventType: eventType,
            $stateKey: stateKey,
        };
        let path = utils.encodeUri("/rooms/$roomId/state/$eventType", pathParams);
        if (stateKey !== undefined) {
            path = utils.encodeUri(path + "/$stateKey", pathParams);
        }
        return this.http.authedRequest(
            callback, "GET", path,
        );
    }

    /**
     * @param {string} roomId
     * @param {string} eventType
     * @param {Object} content
     * @param {string} stateKey
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: TODO
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    sendStateEvent(roomId, eventType, content, stateKey,
                                                       callback) {
        const pathParams = {
            $roomId: roomId,
            $eventType: eventType,
            $stateKey: stateKey,
        };
        let path = utils.encodeUri("/rooms/$roomId/state/$eventType", pathParams);
        if (stateKey !== undefined) {
            path = utils.encodeUri(path + "/$stateKey", pathParams);
        }
        return this.http.authedRequest(
            callback, "PUT", path, undefined, content,
        );
    }

    /**
     * @param {string} roomId
     * @param {Number} limit
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: TODO
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    roomInitialSync(roomId, limit, callback) {
        if (utils.isFunction(limit)) {
            callback = limit; limit = undefined;
        }
        const path = utils.encodeUri("/rooms/$roomId/initialSync",
            {$roomId: roomId},
        );
        if (!limit) {
            limit = 30;
        }
        return this.http.authedRequest(
            callback, "GET", path, { limit: limit },
        );
    }

    /**
     * Set a marker to indicate the point in a room before which the user has read every
     * event. This can be retrieved from room account data (the event type is `m.fully_read`)
     * and displayed as a horizontal line in the timeline that is visually distinct to the
     * position of the user's own read receipt.
     * @param {string} roomId ID of the room that has been read
     * @param {string} rmEventId ID of the event that has been read
     * @param {string} rrEventId ID of the event tracked by the read receipt. This is here
     * for convenience because the RR and the RM are commonly updated at the same time as
     * each other. Optional.
     * @param {object} opts Options for the read markers.
     * @param {object} opts.hidden True to hide the read receipt from other users. <b>This
     * property is currently unstable and may change in the future.</b>
     * @return {Promise} Resolves: the empty object, {}.
     */
    setRoomReadMarkersHttpRequest(roomId, rmEventId, rrEventId, opts) {
        const path = utils.encodeUri("/rooms/$roomId/read_markers", {
            $roomId: roomId,
        });

        const content = {
            "m.fully_read": rmEventId,
            "m.read": rrEventId,
            "m.hidden": Boolean(opts ? opts.hidden : false),
        };

        return this.http.authedRequest(
            undefined, "POST", path, undefined, content,
        );
    }

    /**
     * @return {Promise} Resolves: A list of the user's current rooms
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    getJoinedRooms() {
        const path = utils.encodeUri("/joined_rooms");
        return this.http.authedRequest(undefined, "GET", path);
    }

    /**
     * Retrieve membership info. for a room.
     * @param {string} roomId ID of the room to get membership for
     * @return {Promise} Resolves: A list of currently joined users
     *                                 and their profile data.
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    getJoinedRoomMembers(roomId) {
        const path = utils.encodeUri("/rooms/$roomId/joined_members", {
            $roomId: roomId,
        });
        return this.http.authedRequest(undefined, "GET", path);
    }

    // Room Directory operations
    // =========================

    /**
     * @param {Object} options Options for this request
     * @param {string} options.server The remote server to query for the room list.
     *                                Optional. If unspecified, get the local home
     *                                server's public room list.
     * @param {number} options.limit Maximum number of entries to return
     * @param {string} options.since Token to paginate from
     * @param {object} options.filter Filter parameters
     * @param {string} options.filter.generic_search_term String to search for
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: TODO
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    publicRooms(options, callback) {
        if (typeof(options) === 'function') {
            callback = options;
            options = {};
        }
        if (options === undefined) {
            options = {};
        }

        const query_params = {
            server: options.server,
        };
        if (options.server) {
            delete options.server;
        }

        if (Object.keys(options).length === 0 && Object.keys(query_params).length === 0) {
            return this.http.authedRequest(callback, "GET", "/publicRooms");
        } else {
            return this.http.authedRequest(
                callback, "POST", "/publicRooms", query_params, options,
            );
        }
    }

    /**
     * Create an alias to room ID mapping.
     * @param {string} alias The room alias to create.
     * @param {string} roomId The room ID to link the alias to.
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: TODO.
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    createAlias(alias, roomId, callback) {
        const path = utils.encodeUri("/directory/room/$alias", {
            $alias: alias,
        });
        const data = {
            room_id: roomId,
        };
        return this.http.authedRequest(
            callback, "PUT", path, undefined, data,
        );
    }

    /**
     * Delete an alias to room ID mapping.  This alias must be on your local server
     * and you must have sufficient access to do this operation.
     * @param {string} alias The room alias to delete.
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: TODO.
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    deleteAlias(alias, callback) {
        const path = utils.encodeUri("/directory/room/$alias", {
            $alias: alias,
        });
        return this.http.authedRequest(
            callback, "DELETE", path, undefined, undefined,
        );
    }

    /**
     * @param {string} roomId
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: an object with an `aliases` property, containing an array of local aliases
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    unstableGetLocalAliases(roomId, callback) {
        const path = utils.encodeUri("/rooms/$roomId/aliases",
            {$roomId: roomId});
        const prefix = PREFIX_UNSTABLE + "/org.matrix.msc2432";
        return this.http.authedRequest(callback, "GET", path,
            null, null, { prefix });
    }

    /**
     * Get room info for the given alias.
     * @param {string} alias The room alias to resolve.
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: Object with room_id and servers.
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    getRoomIdForAlias(alias, callback) {
        // TODO: deprecate this or resolveRoomAlias
        const path = utils.encodeUri("/directory/room/$alias", {
            $alias: alias,
        });
        return this.http.authedRequest(
            callback, "GET", path,
        );
    }

    /**
     * @param {string} roomAlias
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: TODO
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    resolveRoomAlias(roomAlias, callback) {
        // TODO: deprecate this or getRoomIdForAlias
        const path = utils.encodeUri("/directory/room/$alias", {$alias: roomAlias});
        return this.http.request(callback, "GET", path);
    }

    /**
     * Get the visibility of a room in the current HS's room directory
     * @param {string} roomId
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: TODO
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    getRoomDirectoryVisibility(roomId, callback) {
        const path = utils.encodeUri("/directory/list/room/$roomId", {
            $roomId: roomId,
        });
        return this.http.authedRequest(callback, "GET", path);
    }

    /**
     * Set the visbility of a room in the current HS's room directory
     * @param {string} roomId
     * @param {string} visibility "public" to make the room visible
     *                 in the public directory, or "private" to make
     *                 it invisible.
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: result object
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    setRoomDirectoryVisibility(roomId, visibility, callback) {
        const path = utils.encodeUri("/directory/list/room/$roomId", {
            $roomId: roomId,
        });
        return this.http.authedRequest(
            callback, "PUT", path, undefined, { "visibility": visibility },
        );
    }

    /**
     * Set the visbility of a room bridged to a 3rd party network in
     * the current HS's room directory.
     * @param {string} networkId the network ID of the 3rd party
     *                 instance under which this room is published under.
     * @param {string} roomId
     * @param {string} visibility "public" to make the room visible
     *                 in the public directory, or "private" to make
     *                 it invisible.
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: result object
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    setRoomDirectoryVisibilityAppService(networkId, roomId, visibility, callback) {
        const path = utils.encodeUri("/directory/list/appservice/$networkId/$roomId", {
            $networkId: networkId,
            $roomId: roomId,
        });
        return this.http.authedRequest(
            callback, "PUT", path, undefined, { "visibility": visibility },
        );
    }

    // User Directory Operations
    // =========================

    /**
     * Query the user directory with a term matching user IDs, display names and domains.
     * @param {object} opts options
     * @param {string} opts.term the term with which to search.
     * @param {number} opts.limit the maximum number of results to return. The server will
     *                 apply a limit if unspecified.
     * @return {Promise} Resolves: an array of results.
     */
    searchUserDirectory(opts) {
        const body = {
            search_term: opts.term,
            limit: opts.limit,
        };

        return this.http.authedRequest(
            undefined, "POST", "/user_directory/search", undefined, body,
        );
    }

    // Media operations
    // ================

    /**
     * Upload a file to the media repository on the home server.
     *
     * @param {object} file The object to upload. On a browser, something that
     *   can be sent to XMLHttpRequest.send (typically a File).  Under node.js,
     *   a a Buffer, String or ReadStream.
     *
     * @param {object} opts  options object
     *
     * @param {string=} opts.name   Name to give the file on the server. Defaults
     *   to <tt>file.name</tt>.
     *
     * @param {boolean=} opts.includeFilename if false will not send the filename,
     *   e.g for encrypted file uploads where filename leaks are undesirable.
     *   Defaults to true.
     *
     * @param {string=} opts.type   Content-type for the upload. Defaults to
     *   <tt>file.type</tt>, or <tt>applicaton/octet-stream</tt>.
     *
     * @param {boolean=} opts.rawResponse Return the raw body, rather than
     *   parsing the JSON. Defaults to false (except on node.js, where it
     *   defaults to true for backwards compatibility).
     *
     * @param {boolean=} opts.onlyContentUri Just return the content URI,
     *   rather than the whole body. Defaults to false (except on browsers,
     *   where it defaults to true for backwards compatibility). Ignored if
     *   opts.rawResponse is true.
     *
     * @param {Function=} opts.callback Deprecated. Optional. The callback to
     *    invoke on success/failure. See the promise return values for more
     *    information.
     *
     * @param {Function=} opts.progressHandler Optional. Called when a chunk of
     *    data has been uploaded, with an object containing the fields `loaded`
     *    (number of bytes transferred) and `total` (total size, if known).
     *
     * @return {Promise} Resolves to response object, as
     *    determined by this.opts.onlyData, opts.rawResponse, and
     *    opts.onlyContentUri.  Rejects with an error (usually a MatrixError).
     */
    uploadContent(file, opts) {
        return this.http.uploadContent(file, opts);
    }

    /**
     * Cancel a file upload in progress
     * @param {Promise} promise The promise returned from uploadContent
     * @return {boolean} true if canceled, otherwise false
     */
    cancelUpload(promise) {
        return this.http.cancelUpload(promise);
    }

    /**
     * Get a list of all file uploads in progress
     * @return {array} Array of objects representing current uploads.
     * Currently in progress is element 0. Keys:
     *  - promise: The promise associated with the upload
     *  - loaded: Number of bytes uploaded
     *  - total: Total number of bytes to upload
     */
    getCurrentUploads() {
        return this.http.getCurrentUploads();
    }

    // Profile operations
    // ==================

    /**
     * @param {string} userId
     * @param {string} info The kind of info to retrieve (e.g. 'displayname',
     * 'avatar_url').
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: TODO
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    getProfileInfo(userId, info, callback) {
        if (utils.isFunction(info)) {
            callback = info; info = undefined;
        }

        const path = info ?
            utils.encodeUri("/profile/$userId/$info",
                { $userId: userId, $info: info }) :
            utils.encodeUri("/profile/$userId",
                { $userId: userId });
        return this.http.authedRequest(callback, "GET", path);
    }

    // Account operations
    // ==================

    /**
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: TODO
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    getThreePids(callback) {
        const path = "/account/3pid";
        return this.http.authedRequest(
            callback, "GET", path, undefined, undefined,
        );
    }

    /**
     * Add a 3PID to your homeserver account and optionally bind it to an identity
     * server as well. An identity server is required as part of the `creds` object.
     *
     * This API is deprecated, and you should instead use `addThreePidOnly`
     * for homeservers that support it.
     *
     * @param {Object} creds
     * @param {boolean} bind
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: on success
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    addThreePid(creds, bind, callback) {
        const path = "/account/3pid";
        const data = {
            'threePidCreds': creds,
            'bind': bind,
        };
        return this.http.authedRequest(
            callback, "POST", path, null, data,
        );
    }

    /**
     * Add a 3PID to your homeserver account. This API does not use an identity
     * server, as the homeserver is expected to handle 3PID ownership validation.
     *
     * You can check whether a homeserver supports this API via
     * `doesServerSupportSeparateAddAndBind`.
     *
     * @param {Object} data A object with 3PID validation data from having called
     * `account/3pid/<medium>/requestToken` on the homeserver.
     * @return {Promise} Resolves: on success
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    async addThreePidOnly(data) {
        const path = "/account/3pid/add";
        const prefix = await this.isVersionSupported("r0.6.0") ?
            PREFIX_R0 : PREFIX_UNSTABLE;
        return this.http.authedRequest(
            undefined, "POST", path, null, data, { prefix },
        );
    }

    /**
     * Bind a 3PID for discovery onto an identity server via the homeserver. The
     * identity server handles 3PID ownership validation and the homeserver records
     * the new binding to track where all 3PIDs for the account are bound.
     *
     * You can check whether a homeserver supports this API via
     * `doesServerSupportSeparateAddAndBind`.
     *
     * @param {Object} data A object with 3PID validation data from having called
     * `validate/<medium>/requestToken` on the identity server. It should also
     * contain `id_server` and `id_access_token` fields as well.
     * @return {Promise} Resolves: on success
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    async bindThreePid(data) {
        const path = "/account/3pid/bind";
        const prefix = await this.isVersionSupported("r0.6.0") ?
            PREFIX_R0 : PREFIX_UNSTABLE;
        return this.http.authedRequest(
            undefined, "POST", path, null, data, { prefix },
        );
    }

    /**
     * Unbind a 3PID for discovery on an identity server via the homeserver. The
     * homeserver removes its record of the binding to keep an updated record of
     * where all 3PIDs for the account are bound.
     *
     * @param {string} medium The threepid medium (eg. 'email')
     * @param {string} address The threepid address (eg. 'bob@example.com')
     *        this must be as returned by getThreePids.
     * @return {Promise} Resolves: on success
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    async unbindThreePid(medium, address) {
        const path = "/account/3pid/unbind";
        const data = {
            medium,
            address,
            id_server: this.getIdentityServerUrl(true),
        };
        const prefix = await this.isVersionSupported("r0.6.0") ?
            PREFIX_R0 : PREFIX_UNSTABLE;
        return this.http.authedRequest(
            undefined, "POST", path, null, data, { prefix },
        );
    }

    /**
     * @param {string} medium The threepid medium (eg. 'email')
     * @param {string} address The threepid address (eg. 'bob@example.com')
     *        this must be as returned by getThreePids.
     * @return {Promise} Resolves: The server response on success
     *     (generally the empty JSON object)
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    deleteThreePid(medium, address) {
        const path = "/account/3pid/delete";
        const data = {
            'medium': medium,
            'address': address,
        };
        return this.http.authedRequest(undefined, "POST", path, null, data);
    }

    /**
     * Make a request to change your password.
     * @param {Object} authDict
     * @param {string} newPassword The new desired password.
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: TODO
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    setPassword(authDict, newPassword, callback) {
        const path = "/account/password";
        const data = {
            'auth': authDict,
            'new_password': newPassword,
        };

        return this.http.authedRequest(
            callback, "POST", path, null, data,
        );
    }


    // Device operations
    // =================

    /**
     * Gets all devices recorded for the logged-in user
     * @return {Promise} Resolves: result object
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    getDevices() {
        return this.http.authedRequest(
            undefined, 'GET', "/devices", undefined, undefined,
        );
    }

    /**
     * Update the given device
     *
     * @param {string} device_id  device to update
     * @param {Object} body       body of request
     * @return {Promise} Resolves: result object
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    setDeviceDetails(device_id, body) {
        const path = utils.encodeUri("/devices/$device_id", {
            $device_id: device_id,
        });

        return this.http.authedRequest(undefined, "PUT", path, undefined, body);
    }

    /**
     * Delete the given device
     *
     * @param {string} device_id  device to delete
     * @param {object} auth Optional. Auth data to supply for User-Interactive auth.
     * @return {Promise} Resolves: result object
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    deleteDevice(device_id, auth) {
        const path = utils.encodeUri("/devices/$device_id", {
            $device_id: device_id,
        });

        return this.http.authedRequest(undefined, "DELETE", path, undefined, { auth });
    }

    /**
     * Delete multiple device
     *
     * @param {string[]} devices IDs of the devices to delete
     * @param {object} auth Optional. Auth data to supply for User-Interactive auth.
     * @return {Promise} Resolves: result object
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    deleteMultipleDevices(devices, auth) {
        const path = "/delete_devices";
        return this.http.authedRequest(undefined, "POST", path, undefined, { devices, auth });
    }


    // Push operations
    // ===============

    /**
     * Gets all pushers registered for the logged-in user
     *
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: Array of objects representing pushers
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    getPushers(callback) {
        const path = "/pushers";
        return this.http.authedRequest(
            callback, "GET", path, undefined, undefined,
        );
    }

    /**
     * Adds a new pusher or updates an existing pusher
     *
     * @param {Object} pusher Object representing a pusher
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: Empty json object on success
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    setPusher(pusher, callback) {
        const path = "/pushers/set";
        return this.http.authedRequest(
            callback, "POST", path, null, pusher,
        );
    }

    /**
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: TODO
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    getPushRules(callback) {
        return this.http.authedRequest(callback, "GET", "/pushrules/").then(rules => {
            return PushProcessor.rewriteDefaultRules(rules);
        });
    }

    /**
     * @param {string} scope
     * @param {string} kind
     * @param {string} ruleId
     * @param {Object} body
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: TODO
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    addPushRule(scope, kind, ruleId, body, callback) {
        // NB. Scope not uri encoded because devices need the '/'
        const path = utils.encodeUri("/pushrules/" + scope + "/$kind/$ruleId", {
            $kind: kind,
            $ruleId: ruleId,
        });
        return this.http.authedRequest(
            callback, "PUT", path, undefined, body,
        );
    }

    /**
     * @param {string} scope
     * @param {string} kind
     * @param {string} ruleId
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: TODO
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    deletePushRule(scope, kind, ruleId, callback) {
        // NB. Scope not uri encoded because devices need the '/'
        const path = utils.encodeUri("/pushrules/" + scope + "/$kind/$ruleId", {
            $kind: kind,
            $ruleId: ruleId,
        });
        return this.http.authedRequest(callback, "DELETE", path);
    }

    /**
     * Enable or disable a push notification rule.
     * @param {string} scope
     * @param {string} kind
     * @param {string} ruleId
     * @param {boolean} enabled
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: result object
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    setPushRuleEnabled(scope, kind,
                                                           ruleId, enabled, callback) {
        const path = utils.encodeUri("/pushrules/" + scope + "/$kind/$ruleId/enabled", {
            $kind: kind,
            $ruleId: ruleId,
        });
        return this.http.authedRequest(
            callback, "PUT", path, undefined, {"enabled": enabled},
        );
    }

    /**
     * Set the actions for a push notification rule.
     * @param {string} scope
     * @param {string} kind
     * @param {string} ruleId
     * @param {array} actions
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: result object
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    setPushRuleActions(scope, kind,
                                                           ruleId, actions, callback) {
        const path = utils.encodeUri("/pushrules/" + scope + "/$kind/$ruleId/actions", {
            $kind: kind,
            $ruleId: ruleId,
        });
        return this.http.authedRequest(
            callback, "PUT", path, undefined, {"actions": actions},
        );
    }

    // Search
    // ======

    /**
     * Perform a server-side search.
     * @param {Object} opts
     * @param {string} opts.next_batch the batch token to pass in the query string
     * @param {Object} opts.body the JSON object to pass to the request body.
     * @param {module:client.callback} callback Optional.
     * @return {Promise} Resolves: TODO
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    search(opts, callback) {
        const queryparams = {
            next_batch: opts.next_batch,
        };
        return this.http.authedRequest(
            callback, "POST", "/search", queryparams, opts.body,
        );
    }

    // Crypto
    // ======

    /**
     * Upload keys
     *
     * @param {Object} content  body of upload request
     *
     * @param {Object=} opts this method no longer takes any opts,
     *  used to take opts.device_id but this was not removed from the spec as a redundant parameter
     *
     * @param {module:client.callback=} callback
     *
     * @return {Promise} Resolves: result object. Rejects: with
     *     an error response ({@link module:http-api.MatrixError}).
     */
    uploadKeysRequest(content, opts, callback) {
        return this.http.authedRequest(callback, "POST", "/keys/upload",
            undefined, content);
    }

    uploadKeySignatures(content) {
        return this.http.authedRequest(
            undefined, "POST", '/keys/signatures/upload', undefined,
            content, {
                prefix: PREFIX_UNSTABLE,
            },
        );
    }

    /**
     * Download device keys
     *
     * @param {string[]} userIds  list of users to get keys for
     *
     * @param {Object=} opts
     *
     * @param {string=} opts.token   sync token to pass in the query request, to help
     *   the HS give the most recent results
     *
     * @return {Promise} Resolves: result object. Rejects: with
     *     an error response ({@link module:http-api.MatrixError}).
     */
    downloadKeysForUsers(userIds, opts) {
        if (utils.isFunction(opts)) {
            // opts used to be 'callback'.
            throw new Error(
                'downloadKeysForUsers no longer accepts a callback parameter',
            );
        }
        opts = opts || {};

        const content = {
            device_keys: {},
            token: opts.token,
        };
        userIds.forEach((u) => {
            content.device_keys[u] = [];
        });

        return this.http.authedRequest(undefined, "POST", "/keys/query",
            undefined, content);
    }

    /**
     * Claim one-time keys
     *
     * @param {string[]} devices  a list of [userId, deviceId] pairs
     *
     * @param {string} [key_algorithm = signed_curve25519]  desired key type
     *
     * @param {number} [timeout] the time (in milliseconds) to wait for keys from remote
     *     servers
     *
     * @return {Promise} Resolves: result object. Rejects: with
     *     an error response ({@link module:http-api.MatrixError}).
     */
    claimOneTimeKeys(devices, key_algorithm, timeout) {
        const queries = {};

        if (key_algorithm === undefined) {
            key_algorithm = "signed_curve25519";
        }

        for (let i = 0; i < devices.length; ++i) {
            const userId = devices[i][0];
            const deviceId = devices[i][1];
            const query = queries[userId] || {};
            queries[userId] = query;
            query[deviceId] = key_algorithm;
        }
        const content = {
            one_time_keys: queries,
            timeout,
        };
        const path = "/keys/claim";
        return this.http.authedRequest(undefined, "POST", path, undefined, content);
    }

    /**
     * Ask the server for a list of users who have changed their device lists
     * between a pair of sync tokens
     *
     * @param {string} oldToken
     * @param {string} newToken
     *
     * @return {Promise} Resolves: result object. Rejects: with
     *     an error response ({@link module:http-api.MatrixError}).
     */
    getKeyChanges(oldToken, newToken) {
        const qps = {
            from: oldToken,
            to: newToken,
        };

        const path = "/keys/changes";
        return this.http.authedRequest(undefined, "GET", path, qps, undefined);
    }

    uploadDeviceSigningKeys(auth, keys) {
        const data = Object.assign({}, keys);
        if (auth) Object.assign(data, {auth});
        return this.http.authedRequest(
            undefined, "POST", "/keys/device_signing/upload", undefined, data, {
                prefix: PREFIX_UNSTABLE,
            },
        );
    }

    // Identity Server Operations
    // ==========================

    /**
     * Register with an Identity Server using the OpenID token from the user's
     * Homeserver, which can be retrieved via
     * {@link module:client~MatrixClient#getOpenIdToken}.
     *
     * Note that the `/account/register` endpoint (as well as IS authentication in
     * general) was added as part of the v2 API version.
     *
     * @param {object} hsOpenIdToken
     * @return {Promise} Resolves: with object containing an Identity
     * Server access token.
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    registerWithIdentityServer(hsOpenIdToken) {
        if (!this.idBaseUrl) {
            throw new Error("No Identity Server base URL set");
        }

        const uri = this.idBaseUrl + PREFIX_IDENTITY_V2 + "/account/register";
        return this.http.requestOtherUrl(
            undefined, "POST", uri,
            null, hsOpenIdToken,
        );
    }

    /**
     * Requests an email verification token directly from an identity server.
     *
     * This API is used as part of binding an email for discovery on an identity
     * server. The validation data that results should be passed to the
     * `bindThreePid` method to complete the binding process.
     *
     * @param {string} email The email address to request a token for
     * @param {string} clientSecret A secret binary string generated by the client.
     *                 It is recommended this be around 16 ASCII characters.
     * @param {number} sendAttempt If an identity server sees a duplicate request
     *                 with the same sendAttempt, it will not send another email.
     *                 To request another email to be sent, use a larger value for
     *                 the sendAttempt param as was used in the previous request.
     * @param {string} nextLink Optional If specified, the client will be redirected
     *                 to this link after validation.
     * @param {module:client.callback} callback Optional.
     * @param {string} identityAccessToken The `access_token` field of the identity
     * server `/account/register` response (see {@link registerWithIdentityServer}).
     *
     * @return {Promise} Resolves: TODO
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     * @throws Error if no identity server is set
     */
    async requestEmailToken(
        email,
        clientSecret,
        sendAttempt,
        nextLink,
        callback,
        identityAccessToken,
    ) {
        const params = {
            client_secret: clientSecret,
            email: email,
            send_attempt: sendAttempt,
            next_link: nextLink,
        };

        return await this.http.idServerRequest(
            callback, "POST", "/validate/email/requestToken",
            params, PREFIX_IDENTITY_V2, identityAccessToken,
        );
    }

    /**
     * Requests a MSISDN verification token directly from an identity server.
     *
     * This API is used as part of binding a MSISDN for discovery on an identity
     * server. The validation data that results should be passed to the
     * `bindThreePid` method to complete the binding process.
     *
     * @param {string} phoneCountry The ISO 3166-1 alpha-2 code for the country in
     *                 which phoneNumber should be parsed relative to.
     * @param {string} phoneNumber The phone number, in national or international
     *                 format
     * @param {string} clientSecret A secret binary string generated by the client.
     *                 It is recommended this be around 16 ASCII characters.
     * @param {number} sendAttempt If an identity server sees a duplicate request
     *                 with the same sendAttempt, it will not send another SMS.
     *                 To request another SMS to be sent, use a larger value for
     *                 the sendAttempt param as was used in the previous request.
     * @param {string} nextLink Optional If specified, the client will be redirected
     *                 to this link after validation.
     * @param {module:client.callback} callback Optional.
     * @param {string} identityAccessToken The `access_token` field of the Identity
     * Server `/account/register` response (see {@link registerWithIdentityServer}).
     *
     * @return {Promise} Resolves: TODO
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     * @throws Error if no identity server is set
     */
    async requestMsisdnToken(
        phoneCountry,
        phoneNumber,
        clientSecret,
        sendAttempt,
        nextLink,
        callback,
        identityAccessToken,
    ) {
        const params = {
            client_secret: clientSecret,
            country: phoneCountry,
            phone_number: phoneNumber,
            send_attempt: sendAttempt,
            next_link: nextLink,
        };

        return await this.http.idServerRequest(
            callback, "POST", "/validate/msisdn/requestToken",
            params, PREFIX_IDENTITY_V2, identityAccessToken,
        );
    }

    /**
     * Submits a MSISDN token to the identity server
     *
     * This is used when submitting the code sent by SMS to a phone number.
     * The ID server has an equivalent API for email but the js-sdk does
     * not expose this, since email is normally validated by the user clicking
     * a link rather than entering a code.
     *
     * @param {string} sid The sid given in the response to requestToken
     * @param {string} clientSecret A secret binary string generated by the client.
     *                 This must be the same value submitted in the requestToken call.
     * @param {string} msisdnToken The MSISDN token, as enetered by the user.
     * @param {string} identityAccessToken The `access_token` field of the Identity
     * Server `/account/register` response (see {@link registerWithIdentityServer}).
     *
     * @return {Promise} Resolves: Object, currently with no parameters.
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     * @throws Error if No ID server is set
     */
    async submitMsisdnToken(
        sid,
        clientSecret,
        msisdnToken,
        identityAccessToken,
    ) {
        const params = {
            sid: sid,
            client_secret: clientSecret,
            token: msisdnToken,
        };

        return await this.http.idServerRequest(
            undefined, "POST", "/validate/msisdn/submitToken",
            params, PREFIX_IDENTITY_V2, identityAccessToken,
        );
    }

    /**
     * Submits a MSISDN token to an arbitrary URL.
     *
     * This is used when submitting the code sent by SMS to a phone number in the
     * newer 3PID flow where the homeserver validates 3PID ownership (as part of
     * `requestAdd3pidMsisdnToken`). The homeserver response may include a
     * `submit_url` to specify where the token should be sent, and this helper can
     * be used to pass the token to this URL.
     *
     * @param {string} url The URL to submit the token to
     * @param {string} sid The sid given in the response to requestToken
     * @param {string} clientSecret A secret binary string generated by the client.
     *                 This must be the same value submitted in the requestToken call.
     * @param {string} msisdnToken The MSISDN token, as enetered by the user.
     *
     * @return {Promise} Resolves: Object, currently with no parameters.
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    submitMsisdnTokenOtherUrl(
        url,
        sid,
        clientSecret,
        msisdnToken,
    ) {
        const params = {
            sid: sid,
            client_secret: clientSecret,
            token: msisdnToken,
        };

        return this.http.requestOtherUrl(
            undefined, "POST", url, undefined, params,
        );
    }

    /**
     * Gets the V2 hashing information from the identity server. Primarily useful for
     * lookups.
     * @param {string} identityAccessToken The access token for the identity server.
     * @returns {Promise<object>} The hashing information for the identity server.
     */
    getIdentityHashDetails(identityAccessToken) {
        return this.http.idServerRequest(
            undefined, "GET", "/hash_details",
            null, PREFIX_IDENTITY_V2, identityAccessToken,
        );
    }

    /**
     * Performs a hashed lookup of addresses against the identity server. This is
     * only supported on identity servers which have at least the version 2 API.
     * @param {Array<Array<string,string>>} addressPairs An array of 2 element arrays.
     * The first element of each pair is the address, the second is the 3PID medium.
     * Eg: ["email@example.org", "email"]
     * @param {string} identityAccessToken The access token for the identity server.
     * @returns {Promise<Array<{address, mxid}>>} A collection of address mappings to
     * found MXIDs. Results where no user could be found will not be listed.
     */
    async identityHashedLookup(
        addressPairs, // [["email@example.org", "email"], ["10005550000", "msisdn"]]
        identityAccessToken,
    ) {
        const params = {
            // addresses: ["email@example.org", "10005550000"],
            // algorithm: "sha256",
            // pepper: "abc123"
        };

        // Get hash information first before trying to do a lookup
        const hashes = await this.getIdentityHashDetails(identityAccessToken);
        if (!hashes || !hashes['lookup_pepper'] || !hashes['algorithms']) {
            throw new Error("Unsupported identity server: bad response");
        }

        params['pepper'] = hashes['lookup_pepper'];

        const localMapping = {
            // hashed identifier => plain text address
            // For use in this function's return format
        };

        // When picking an algorithm, we pick the hashed over no hashes
        if (hashes['algorithms'].includes('sha256')) {
            // Abuse the olm hashing
            const olmutil = new global.Olm.Utility();
            params["addresses"] = addressPairs.map(p => {
                const addr = p[0].toLowerCase(); // lowercase to get consistent hashes
                const med = p[1].toLowerCase();
                const hashed = olmutil.sha256(`${addr} ${med} ${params['pepper']}`)
                    .replace(/\+/g, '-').replace(/\//g, '_'); // URL-safe base64
                // Map the hash to a known (case-sensitive) address. We use the case
                // sensitive version because the caller might be expecting that.
                localMapping[hashed] = p[0];
                return hashed;
            });
            params["algorithm"] = "sha256";
        } else if (hashes['algorithms'].includes('none')) {
            params["addresses"] = addressPairs.map(p => {
                const addr = p[0].toLowerCase(); // lowercase to get consistent hashes
                const med = p[1].toLowerCase();
                const unhashed = `${addr} ${med}`;
                // Map the unhashed values to a known (case-sensitive) address. We use
                // the case sensitive version because the caller might be expecting that.
                localMapping[unhashed] = p[0];
                return unhashed;
            });
            params["algorithm"] = "none";
        } else {
            throw new Error("Unsupported identity server: unknown hash algorithm");
        }

        const response = await this.http.idServerRequest(
            undefined, "POST", "/lookup",
            params, PREFIX_IDENTITY_V2, identityAccessToken,
        );

        if (!response || !response['mappings']) return []; // no results

        const foundAddresses = [/* {address: "plain@example.org", mxid} */];
        for (const hashed of Object.keys(response['mappings'])) {
            const mxid = response['mappings'][hashed];
            const plainAddress = localMapping[hashed];
            if (!plainAddress) {
                throw new Error("Identity server returned more results than expected");
            }

            foundAddresses.push({address: plainAddress, mxid});
        }
        return foundAddresses;
    }

    /**
     * Looks up the public Matrix ID mapping for a given 3rd party
     * identifier from the Identity Server
     *
     * @param {string} medium The medium of the threepid, eg. 'email'
     * @param {string} address The textual address of the threepid
     * @param {module:client.callback} callback Optional.
     * @param {string} identityAccessToken The `access_token` field of the Identity
     * Server `/account/register` response (see {@link registerWithIdentityServer}).
     *
     * @return {Promise} Resolves: A threepid mapping
     *                                 object or the empty object if no mapping
     *                                 exists
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    async lookupThreePid(
        medium,
        address,
        callback,
        identityAccessToken,
    ) {
        // Note: we're using the V2 API by calling this function, but our
        // function contract requires a V1 response. We therefore have to
        // convert it manually.
        const response = await this.identityHashedLookup(
            [[address, medium]], identityAccessToken,
        );
        const result = response.find(p => p.address === address);
        if (!result) {
            if (callback) callback(null, {});
            return {};
        }

        const mapping = {
            address,
            medium,
            mxid: result.mxid,

            // We can't reasonably fill these parameters:
            // not_before
            // not_after
            // ts
            // signatures
        };

        if (callback) callback(null, mapping);
        return mapping;
    }

    /**
     * Looks up the public Matrix ID mappings for multiple 3PIDs.
     *
     * @param {Array.<Array.<string>>} query Array of arrays containing
     * [medium, address]
     * @param {string} identityAccessToken The `access_token` field of the Identity
     * Server `/account/register` response (see {@link registerWithIdentityServer}).
     *
     * @return {Promise} Resolves: Lookup results from IS.
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    async bulkLookupThreePids(query, identityAccessToken) {
        // Note: we're using the V2 API by calling this function, but our
        // function contract requires a V1 response. We therefore have to
        // convert it manually.
        const response = await this.identityHashedLookup(
            // We have to reverse the query order to get [address, medium] pairs
            query.map(p => [p[1], p[0]]), identityAccessToken,
        );

        const v1results = [];
        for (const mapping of response) {
            const originalQuery = query.find(p => p[1] === mapping.address);
            if (!originalQuery) {
                throw new Error("Identity sever returned unexpected results");
            }

            v1results.push([
                originalQuery[0], // medium
                mapping.address,
                mapping.mxid,
            ]);
        }

        return {threepids: v1results};
    }

    /**
     * Get account info from the Identity Server. This is useful as a neutral check
     * to verify that other APIs are likely to approve access by testing that the
     * token is valid, terms have been agreed, etc.
     *
     * @param {string} identityAccessToken The `access_token` field of the Identity
     * Server `/account/register` response (see {@link registerWithIdentityServer}).
     *
     * @return {Promise} Resolves: an object with account info.
     * @return {module:http-api.MatrixError} Rejects: with an error response.
     */
    getIdentityAccount(
        identityAccessToken,
    ) {
        return this.http.idServerRequest(
            undefined, "GET", "/account",
            undefined, PREFIX_IDENTITY_V2, identityAccessToken,
        );
    }

    // Direct-to-device messaging
    // ==========================

    /**
     * Send an event to a specific list of devices
     *
     * @param {string} eventType  type of event to send
     * @param {Object.<string, Object<string, Object>>} contentMap
     *    content to send. Map from user_id to device_id to content object.
     * @param {string=} txnId     transaction id. One will be made up if not
     *    supplied.
     * @return {Promise} Resolves to the result object
     */
    sendToDevice(
        eventType, contentMap, txnId,
    ) {
        const path = utils.encodeUri("/sendToDevice/$eventType/$txnId", {
            $eventType: eventType,
            $txnId: txnId ? txnId : this.makeTxnId(),
        });

        const body = {
            messages: contentMap,
        };

        const targets = Object.keys(contentMap).reduce((obj, key) => {
            obj[key] = Object.keys(contentMap[key]);
            return obj;
        }, {});
        logger.log(`PUT ${path}`, targets);

        return this.http.authedRequest(undefined, "PUT", path, undefined, body);
    }

    // Third party Lookup API
    // ======================

    /**
     * Get the third party protocols that can be reached using
     * this HS
     * @return {Promise} Resolves to the result object
     */
    getThirdpartyProtocols() {
        return this.http.authedRequest(
            undefined, "GET", "/thirdparty/protocols", undefined, undefined,
        ).then((response) => {
            // sanity check
            if (!response || typeof(response) !== 'object') {
                throw new Error(
                    `/thirdparty/protocols did not return an object: ${response}`,
                );
            }
            return response;
        });
    }

    /**
     * Get information on how a specific place on a third party protocol
     * may be reached.
     * @param {string} protocol The protocol given in getThirdpartyProtocols()
     * @param {object} params Protocol-specific parameters, as given in the
     *                        response to getThirdpartyProtocols()
     * @return {Promise} Resolves to the result object
     */
    getThirdpartyLocation(protocol, params) {
        const path = utils.encodeUri("/thirdparty/location/$protocol", {
            $protocol: protocol,
        });

        return this.http.authedRequest(undefined, "GET", path, params, undefined);
    }

    /**
     * Get information on how a specific user on a third party protocol
     * may be reached.
     * @param {string} protocol The protocol given in getThirdpartyProtocols()
     * @param {object} params Protocol-specific parameters, as given in the
     *                        response to getThirdpartyProtocols()
     * @return {Promise} Resolves to the result object
     */
    getThirdpartyUser(protocol, params) {
        const path = utils.encodeUri("/thirdparty/user/$protocol", {
            $protocol: protocol,
        });

        return this.http.authedRequest(undefined, "GET", path, params, undefined);
    }

    getTerms(serviceType, baseUrl) {
        const url = termsUrlForService(serviceType, baseUrl);
        return this.http.requestOtherUrl(
            undefined, 'GET', url,
        );
    }

    agreeToTerms(
        serviceType, baseUrl, accessToken, termsUrls,
    ) {
        const url = termsUrlForService(serviceType, baseUrl);
        const headers = {
            Authorization: "Bearer " + accessToken,
        };
        return this.http.requestOtherUrl(
            undefined, 'POST', url, null, { user_accepts: termsUrls }, { headers },
        );
    }

    /**
     * Reports an event as inappropriate to the server, which may then notify the appropriate people.
     * @param {string} roomId The room in which the event being reported is located.
     * @param {string} eventId The event to report.
     * @param {number} score The score to rate this content as where -100 is most offensive and 0 is inoffensive.
     * @param {string} reason The reason the content is being reported. May be blank.
     * @returns {Promise} Resolves to an empty object if successful
     */
    reportEvent(roomId, eventId, score, reason) {
        const path = utils.encodeUri("/rooms/$roomId/report/$eventId", {
            $roomId: roomId,
            $eventId: eventId,
        });

        return this.http.authedRequest(undefined, "POST", path, null, {score, reason});
    }
}