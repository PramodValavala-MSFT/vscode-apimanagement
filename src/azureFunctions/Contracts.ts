/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.md in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// tslint:disable:interface-name
export interface FunctionKeys {
    keys: Key[];
    links: Link[];
}

export interface Link {
    rel: string;
    href: string;
}

export interface Key {
    name: string;
    value: string;
}

export interface FunctionKey {
    name: string;
    value: string;
    links: Link[];
}

export interface FunctionHost {
    http: {
        routePrefix: string;
        maxOutstandingRequests: number;
        maxConcurrentRequests: number;
        dynamicThrottlesEnabled: boolean;
    };
}