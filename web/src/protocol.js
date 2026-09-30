/*
 * GENERATED FILE - DO NOT EDIT.
 *
 * Source:    web/protocol.json (obs-websocket protocol definition)
 * Generator: web/tools/gen-protocol.mjs
 *
 * Regenerate with:  node tools/gen-protocol.mjs
 */

/* Bit flags for the Identify message / EVENT_SUBSCRIPTION. */
export const EventSubscription = Object.freeze({
  None: 0, // Subcription value used to disable all events.
  General: 1, // Subscription value to receive events in the `General` category. (= (1 << 0))
  Config: 2, // Subscription value to receive events in the `Config` category. (= (1 << 1))
  Scenes: 4, // Subscription value to receive events in the `Scenes` category. (= (1 << 2))
  Inputs: 8, // Subscription value to receive events in the `Inputs` category. (= (1 << 3))
  Transitions: 16, // Subscription value to receive events in the `Transitions` category. (= (1 << 4))
  Filters: 32, // Subscription value to receive events in the `Filters` category. (= (1 << 5))
  Outputs: 64, // Subscription value to receive events in the `Outputs` category. (= (1 << 6))
  SceneItems: 128, // Subscription value to receive events in the `SceneItems` category. (= (1 << 7))
  MediaInputs: 256, // Subscription value to receive events in the `MediaInputs` category. (= (1 << 8))
  Vendors: 512, // Subscription value to receive the `VendorEvent` event. (= (1 << 9))
  Ui: 1024, // Subscription value to receive events in the `Ui` category. (= (1 << 10))
  Canvases: 2048, // Subscription value to receive events in the `Canvases` category. (= (1 << 11))
  All: 4095, // Helper to receive all non-high-volume events. (= (General | Config | Scenes | Inputs | Transitions | Filters | Outputs | SceneItems | MediaInputs | Vendors | Ui | Canvases))
  InputVolumeMeters: 65536, // Subscription value to receive the `InputVolumeMeters` high-volume event. (= (1 << 16))
  InputActiveStateChanged: 131072, // Subscription value to receive the `InputActiveStateChanged` high-volume event. (= (1 << 17))
  InputShowStateChanged: 262144, // Subscription value to receive the `InputShowStateChanged` high-volume event. (= (1 << 18))
  SceneItemTransformChanged: 524288, // Subscription value to receive the `SceneItemTransformChanged` high-volume event. (= (1 << 19))
});

export const RequestBatchExecutionType = Object.freeze({
  None: -1, // Not a request batch.
  SerialRealtime: 0, // A request batch which processes all requests serially, as fast as possible.
  SerialFrame: 1, // A request batch type which processes all requests serially, in sync with the graphics thre
  Parallel: 2, // A request batch type which processes all requests using all available threads in the threa
});

export const RequestStatus = Object.freeze({
  Unknown: 0, // Unknown status, should never be used.
  NoError: 10, // For internal use to signify a successful field check.
  Success: 100, // The request has succeeded.
  MissingRequestType: 203, // The `requestType` field is missing from the request data.
  UnknownRequestType: 204, // The request type is invalid or does not exist.
  GenericError: 205, // Generic error code.
  UnsupportedRequestBatchExecutionType: 206, // The request batch execution type is not supported.
  NotReady: 207, // The server is not ready to handle the request.
  MissingRequestField: 300, // A required request field is missing.
  MissingRequestData: 301, // The request does not have a valid requestData object.
  InvalidRequestField: 400, // Generic invalid request field message.
  InvalidRequestFieldType: 401, // A request field has the wrong data type.
  RequestFieldOutOfRange: 402, // A request field (number) is outside of the allowed range.
  RequestFieldEmpty: 403, // A request field (string or array) is empty and cannot be.
  TooManyRequestFields: 404, // There are too many request fields (eg. a request takes two optionals, where only one is al
  OutputRunning: 500, // An output is running and cannot be in order to perform the request.
  OutputNotRunning: 501, // An output is not running and should be.
  OutputPaused: 502, // An output is paused and should not be.
  OutputNotPaused: 503, // An output is not paused and should be.
  OutputDisabled: 504, // An output is disabled and should not be.
  StudioModeActive: 505, // Studio mode is active and cannot be.
  StudioModeNotActive: 506, // Studio mode is not active and should be.
  ResourceNotFound: 600, // The resource was not found.
  ResourceAlreadyExists: 601, // The resource already exists.
  InvalidResourceType: 602, // The type of resource found is invalid.
  NotEnoughResources: 603, // There are not enough instances of the resource in order to perform the request.
  InvalidResourceState: 604, // The state of the resource is invalid. For example, if the resource is blocked from being a
  InvalidInputKind: 605, // The specified input (obs_source_t-OBS_SOURCE_TYPE_INPUT) had the wrong kind.
  ResourceNotConfigurable: 606, // The resource does not support being configured.
  InvalidFilterKind: 607, // The specified filter (obs_source_t-OBS_SOURCE_TYPE_FILTER) had the wrong kind.
  ResourceCreationFailed: 700, // Creating the resource failed.
  ResourceActionFailed: 701, // Performing an action on the resource failed.
  RequestProcessingFailed: 702, // Processing the request failed unexpectedly.
  CannotAct: 703, // The combination of request fields cannot be used to perform an action.
});

export const ObsOutputState = Object.freeze({
  OBS_WEBSOCKET_OUTPUT_UNKNOWN: "OBS_WEBSOCKET_OUTPUT_UNKNOWN", // Unknown state. (= OBS_WEBSOCKET_OUTPUT_UNKNOWN)
  OBS_WEBSOCKET_OUTPUT_STARTING: "OBS_WEBSOCKET_OUTPUT_STARTING", // The output is starting. (= OBS_WEBSOCKET_OUTPUT_STARTING)
  OBS_WEBSOCKET_OUTPUT_STARTED: "OBS_WEBSOCKET_OUTPUT_STARTED", // The input has started. (= OBS_WEBSOCKET_OUTPUT_STARTED)
  OBS_WEBSOCKET_OUTPUT_STOPPING: "OBS_WEBSOCKET_OUTPUT_STOPPING", // The output is stopping. (= OBS_WEBSOCKET_OUTPUT_STOPPING)
  OBS_WEBSOCKET_OUTPUT_STOPPED: "OBS_WEBSOCKET_OUTPUT_STOPPED", // The output has stopped. (= OBS_WEBSOCKET_OUTPUT_STOPPED)
  OBS_WEBSOCKET_OUTPUT_RECONNECTING: "OBS_WEBSOCKET_OUTPUT_RECONNECTING", // The output has disconnected and is reconnecting. (= OBS_WEBSOCKET_OUTPUT_RECONNECTING)
  OBS_WEBSOCKET_OUTPUT_RECONNECTED: "OBS_WEBSOCKET_OUTPUT_RECONNECTED", // The output has reconnected successfully. (= OBS_WEBSOCKET_OUTPUT_RECONNECTED)
  OBS_WEBSOCKET_OUTPUT_PAUSED: "OBS_WEBSOCKET_OUTPUT_PAUSED", // The output is now paused. (= OBS_WEBSOCKET_OUTPUT_PAUSED)
  OBS_WEBSOCKET_OUTPUT_RESUMED: "OBS_WEBSOCKET_OUTPUT_RESUMED", // The output has been resumed (unpaused). (= OBS_WEBSOCKET_OUTPUT_RESUMED)
});

export const ObsMediaInputAction = Object.freeze({
  OBS_WEBSOCKET_MEDIA_INPUT_ACTION_NONE: "OBS_WEBSOCKET_MEDIA_INPUT_ACTION_NONE", // No action. (= OBS_WEBSOCKET_MEDIA_INPUT_ACTION_NONE)
  OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PLAY: "OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PLAY", // Play the media input. (= OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PLAY)
  OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PAUSE: "OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PAUSE", // Pause the media input. (= OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PAUSE)
  OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP: "OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP", // Stop the media input. (= OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP)
  OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART: "OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART", // Restart the media input. (= OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART)
  OBS_WEBSOCKET_MEDIA_INPUT_ACTION_NEXT: "OBS_WEBSOCKET_MEDIA_INPUT_ACTION_NEXT", // Go to the next playlist item. (= OBS_WEBSOCKET_MEDIA_INPUT_ACTION_NEXT)
  OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PREVIOUS: "OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PREVIOUS", // Go to the previous playlist item. (= OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PREVIOUS)
});

export const WebSocketCloseCode = Object.freeze({
  DontClose: 0, // For internal use only to tell the request handler not to perform any close action.
  UnknownReason: 4000, // Unknown reason, should never be used.
  MessageDecodeError: 4002, // The server was unable to decode the incoming websocket message.
  MissingDataField: 4003, // A data field is required but missing from the payload.
  InvalidDataFieldType: 4004, // A data field's value type is invalid.
  InvalidDataFieldValue: 4005, // A data field's value is invalid.
  UnknownOpCode: 4006, // The specified `op` was invalid or missing.
  NotIdentified: 4007, // The client sent a websocket message without first sending `Identify` message.
  AlreadyIdentified: 4008, // The client sent an `Identify` message while already identified.
  AuthenticationFailed: 4009, // The authentication attempt (via `Identify`) failed.
  UnsupportedRpcVersion: 4010, // The server detected the usage of an old version of the obs-websocket RPC protocol.
  SessionInvalidated: 4011, // The websocket session has been invalidated by the obs-websocket server.
  UnsupportedFeature: 4012, // A requested feature is not supported due to hardware/software limitations.
});

export const WebSocketOpCode = Object.freeze({
  Hello: 0, // The initial message sent by obs-websocket to newly connected clients.
  Identify: 1, // The message sent by a newly connected client to obs-websocket in response to a `Hello`.
  Identified: 2, // The response sent by obs-websocket to a client after it has successfully identified with o
  Reidentify: 3, // The message sent by an already-identified client to update identification parameters.
  Event: 5, // The message sent by obs-websocket containing an event payload.
  Request: 6, // The message sent by a client to obs-websocket to perform a request.
  RequestResponse: 7, // The message sent by obs-websocket in response to a particular request from a client.
  RequestBatch: 8, // The message sent by a client to obs-websocket to perform a batch of requests.
  RequestBatchResponse: 9, // The message sent by obs-websocket in response to a particular batch of requests from a cli
});


/* Request metadata: category, complexity and field descriptors. */
export const REQUESTS = {
  "GetCanvasList": {
    "category": "canvases",
    "complexity": 3,
    "description": "Gets an array of canvases in OBS.",
    "fields": []
  },
  "GetPersistentData": {
    "category": "config",
    "complexity": 2,
    "description": "Gets the value of a \"slot\" from the selected persistent data realm.",
    "fields": [
      {
        "name": "realm",
        "type": "String",
        "optional": false,
        "description": "The data realm to select. `OBS_WEBSOCKET_DATA_REALM_GLOBAL` or `OBS_WEBSOCKET_DATA_REALM_PROFILE`",
        "restrictions": null
      },
      {
        "name": "slotName",
        "type": "String",
        "optional": false,
        "description": "The name of the slot to retrieve data from",
        "restrictions": null
      }
    ]
  },
  "SetPersistentData": {
    "category": "config",
    "complexity": 2,
    "description": "Sets the value of a \"slot\" from the selected persistent data realm.",
    "fields": [
      {
        "name": "realm",
        "type": "String",
        "optional": false,
        "description": "The data realm to select. `OBS_WEBSOCKET_DATA_REALM_GLOBAL` or `OBS_WEBSOCKET_DATA_REALM_PROFILE`",
        "restrictions": null
      },
      {
        "name": "slotName",
        "type": "String",
        "optional": false,
        "description": "The name of the slot to retrieve data from",
        "restrictions": null
      },
      {
        "name": "slotValue",
        "type": "Any",
        "optional": false,
        "description": "The value to apply to the slot",
        "restrictions": null
      }
    ]
  },
  "GetSceneCollectionList": {
    "category": "config",
    "complexity": 1,
    "description": "Gets an array of all scene collections",
    "fields": []
  },
  "SetCurrentSceneCollection": {
    "category": "config",
    "complexity": 1,
    "description": "Switches to a scene collection.",
    "fields": [
      {
        "name": "sceneCollectionName",
        "type": "String",
        "optional": false,
        "description": "Name of the scene collection to switch to",
        "restrictions": null
      }
    ]
  },
  "CreateSceneCollection": {
    "category": "config",
    "complexity": 1,
    "description": "Creates a new scene collection, switching to it in the process.",
    "fields": [
      {
        "name": "sceneCollectionName",
        "type": "String",
        "optional": false,
        "description": "Name for the new scene collection",
        "restrictions": null
      }
    ]
  },
  "GetProfileList": {
    "category": "config",
    "complexity": 1,
    "description": "Gets an array of all profiles",
    "fields": []
  },
  "SetCurrentProfile": {
    "category": "config",
    "complexity": 1,
    "description": "Switches to a profile.",
    "fields": [
      {
        "name": "profileName",
        "type": "String",
        "optional": false,
        "description": "Name of the profile to switch to",
        "restrictions": null
      }
    ]
  },
  "CreateProfile": {
    "category": "config",
    "complexity": 1,
    "description": "Creates a new profile, switching to it in the process",
    "fields": [
      {
        "name": "profileName",
        "type": "String",
        "optional": false,
        "description": "Name for the new profile",
        "restrictions": null
      }
    ]
  },
  "RemoveProfile": {
    "category": "config",
    "complexity": 1,
    "description": "Removes a profile. If the current profile is chosen, it will change to a different profile first.",
    "fields": [
      {
        "name": "profileName",
        "type": "String",
        "optional": false,
        "description": "Name of the profile to remove",
        "restrictions": null
      }
    ]
  },
  "GetProfileParameter": {
    "category": "config",
    "complexity": 4,
    "description": "Gets a parameter from the current profile's configuration.",
    "fields": [
      {
        "name": "parameterCategory",
        "type": "String",
        "optional": false,
        "description": "Category of the parameter to get",
        "restrictions": null
      },
      {
        "name": "parameterName",
        "type": "String",
        "optional": false,
        "description": "Name of the parameter to get",
        "restrictions": null
      }
    ]
  },
  "SetProfileParameter": {
    "category": "config",
    "complexity": 4,
    "description": "Sets the value of a parameter in the current profile's configuration.",
    "fields": [
      {
        "name": "parameterCategory",
        "type": "String",
        "optional": false,
        "description": "Category of the parameter to set",
        "restrictions": null
      },
      {
        "name": "parameterName",
        "type": "String",
        "optional": false,
        "description": "Name of the parameter to set",
        "restrictions": null
      },
      {
        "name": "parameterValue",
        "type": "String",
        "optional": false,
        "description": "Value of the parameter to set. Use `null` to delete",
        "restrictions": null
      }
    ]
  },
  "GetVideoSettings": {
    "category": "config",
    "complexity": 2,
    "description": "Gets the current video settings.",
    "fields": []
  },
  "SetVideoSettings": {
    "category": "config",
    "complexity": 2,
    "description": "Sets the current video settings.",
    "fields": [
      {
        "name": "fpsNumerator",
        "type": "Number",
        "optional": true,
        "description": "Numerator of the fractional FPS value",
        "restrictions": ">= 1"
      },
      {
        "name": "fpsDenominator",
        "type": "Number",
        "optional": true,
        "description": "Denominator of the fractional FPS value",
        "restrictions": ">= 1"
      },
      {
        "name": "baseWidth",
        "type": "Number",
        "optional": true,
        "description": "Width of the base (canvas) resolution in pixels",
        "restrictions": ">= 1, <= 4096"
      },
      {
        "name": "baseHeight",
        "type": "Number",
        "optional": true,
        "description": "Height of the base (canvas) resolution in pixels",
        "restrictions": ">= 1, <= 4096"
      },
      {
        "name": "outputWidth",
        "type": "Number",
        "optional": true,
        "description": "Width of the output resolution in pixels",
        "restrictions": ">= 1, <= 4096"
      },
      {
        "name": "outputHeight",
        "type": "Number",
        "optional": true,
        "description": "Height of the output resolution in pixels",
        "restrictions": ">= 1, <= 4096"
      }
    ]
  },
  "GetStreamServiceSettings": {
    "category": "config",
    "complexity": 4,
    "description": "Gets the current stream service settings (stream destination).",
    "fields": []
  },
  "SetStreamServiceSettings": {
    "category": "config",
    "complexity": 4,
    "description": "Sets the current stream service settings (stream destination).",
    "fields": [
      {
        "name": "streamServiceType",
        "type": "String",
        "optional": false,
        "description": "Type of stream service to apply. Example: `rtmp_common` or `rtmp_custom`",
        "restrictions": null
      },
      {
        "name": "streamServiceSettings",
        "type": "Object",
        "optional": false,
        "description": "Settings to apply to the service",
        "restrictions": null
      }
    ]
  },
  "GetRecordDirectory": {
    "category": "config",
    "complexity": 2,
    "description": "Gets the current directory that the record output is set to.",
    "fields": []
  },
  "SetRecordDirectory": {
    "category": "config",
    "complexity": 2,
    "description": "Sets the current directory that the record output writes files to.",
    "fields": [
      {
        "name": "recordDirectory",
        "type": "String",
        "optional": false,
        "description": "Output directory",
        "restrictions": null
      }
    ]
  },
  "GetSourceFilterKindList": {
    "category": "filters",
    "complexity": 2,
    "description": "Gets an array of all available source filter kinds.",
    "fields": []
  },
  "GetSourceFilterList": {
    "category": "filters",
    "complexity": 2,
    "description": "Gets an array of all of a source's filters.",
    "fields": [
      {
        "name": "canvasUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the canvas the source is in, if using the sourceName field",
        "restrictions": null
      },
      {
        "name": "sourceName",
        "type": "String",
        "optional": true,
        "description": "Name of the source",
        "restrictions": null
      },
      {
        "name": "sourceUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the source",
        "restrictions": null
      }
    ]
  },
  "GetSourceFilterDefaultSettings": {
    "category": "filters",
    "complexity": 3,
    "description": "Gets the default settings for a filter kind.",
    "fields": [
      {
        "name": "filterKind",
        "type": "String",
        "optional": false,
        "description": "Filter kind to get the default settings for",
        "restrictions": null
      }
    ]
  },
  "CreateSourceFilter": {
    "category": "filters",
    "complexity": 3,
    "description": "Creates a new filter, adding it to the specified source.",
    "fields": [
      {
        "name": "canvasUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the canvas the source is in, if using the sourceName field",
        "restrictions": null
      },
      {
        "name": "sourceName",
        "type": "String",
        "optional": true,
        "description": "Name of the source to add the filter to",
        "restrictions": null
      },
      {
        "name": "sourceUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the source to add the filter to",
        "restrictions": null
      },
      {
        "name": "filterName",
        "type": "String",
        "optional": false,
        "description": "Name of the new filter to be created",
        "restrictions": null
      },
      {
        "name": "filterKind",
        "type": "String",
        "optional": false,
        "description": "The kind of filter to be created",
        "restrictions": null
      },
      {
        "name": "filterSettings",
        "type": "Object",
        "optional": true,
        "description": "Settings object to initialize the filter with",
        "restrictions": null
      }
    ]
  },
  "RemoveSourceFilter": {
    "category": "filters",
    "complexity": 2,
    "description": "Removes a filter from a source.",
    "fields": [
      {
        "name": "canvasUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the canvas the source is in, if using the sourceName field",
        "restrictions": null
      },
      {
        "name": "sourceName",
        "type": "String",
        "optional": true,
        "description": "Name of the source the filter is on",
        "restrictions": null
      },
      {
        "name": "sourceUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the source the filter is on",
        "restrictions": null
      },
      {
        "name": "filterName",
        "type": "String",
        "optional": false,
        "description": "Name of the filter to remove",
        "restrictions": null
      }
    ]
  },
  "SetSourceFilterName": {
    "category": "filters",
    "complexity": 2,
    "description": "Sets the name of a source filter (rename).",
    "fields": [
      {
        "name": "canvasUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the canvas the source is in, if using the sourceName field",
        "restrictions": null
      },
      {
        "name": "sourceName",
        "type": "String",
        "optional": true,
        "description": "Name of the source the filter is on",
        "restrictions": null
      },
      {
        "name": "sourceUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the source the filter is on",
        "restrictions": null
      },
      {
        "name": "filterName",
        "type": "String",
        "optional": false,
        "description": "Current name of the filter",
        "restrictions": null
      },
      {
        "name": "newFilterName",
        "type": "String",
        "optional": false,
        "description": "New name for the filter",
        "restrictions": null
      }
    ]
  },
  "GetSourceFilter": {
    "category": "filters",
    "complexity": 2,
    "description": "Gets the info for a specific source filter.",
    "fields": [
      {
        "name": "canvasUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the canvas the source is in, if using the sourceName field",
        "restrictions": null
      },
      {
        "name": "sourceName",
        "type": "String",
        "optional": true,
        "description": "Name of the source",
        "restrictions": null
      },
      {
        "name": "sourceUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the source",
        "restrictions": null
      },
      {
        "name": "filterName",
        "type": "String",
        "optional": false,
        "description": "Name of the filter",
        "restrictions": null
      }
    ]
  },
  "SetSourceFilterIndex": {
    "category": "filters",
    "complexity": 3,
    "description": "Sets the index position of a filter on a source.",
    "fields": [
      {
        "name": "canvasUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the canvas the source is in, if using the sourceName field",
        "restrictions": null
      },
      {
        "name": "sourceName",
        "type": "String",
        "optional": true,
        "description": "Name of the source the filter is on",
        "restrictions": null
      },
      {
        "name": "sourceUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the source the filter is on",
        "restrictions": null
      },
      {
        "name": "filterName",
        "type": "String",
        "optional": false,
        "description": "Name of the filter",
        "restrictions": null
      },
      {
        "name": "filterIndex",
        "type": "Number",
        "optional": false,
        "description": "New index position of the filter",
        "restrictions": ">= 0"
      }
    ]
  },
  "SetSourceFilterSettings": {
    "category": "filters",
    "complexity": 3,
    "description": "Sets the settings of a source filter.",
    "fields": [
      {
        "name": "canvasUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the canvas the source is in, if using the sourceName field",
        "restrictions": null
      },
      {
        "name": "sourceName",
        "type": "String",
        "optional": true,
        "description": "Name of the source the filter is on",
        "restrictions": null
      },
      {
        "name": "sourceUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the source the filter is on",
        "restrictions": null
      },
      {
        "name": "filterName",
        "type": "String",
        "optional": false,
        "description": "Name of the filter to set the settings of",
        "restrictions": null
      },
      {
        "name": "filterSettings",
        "type": "Object",
        "optional": false,
        "description": "Object of settings to apply",
        "restrictions": null
      },
      {
        "name": "overlay",
        "type": "Boolean",
        "optional": true,
        "description": "True == apply the settings on top of existing ones, False == reset the input to its defaults, then apply settings.",
        "restrictions": null
      }
    ]
  },
  "SetSourceFilterEnabled": {
    "category": "filters",
    "complexity": 3,
    "description": "Sets the enable state of a source filter.",
    "fields": [
      {
        "name": "canvasUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the canvas the source is in, if using the sourceName field",
        "restrictions": null
      },
      {
        "name": "sourceName",
        "type": "String",
        "optional": true,
        "description": "Name of the source the filter is on",
        "restrictions": null
      },
      {
        "name": "sourceUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the source the filter is on",
        "restrictions": null
      },
      {
        "name": "filterName",
        "type": "String",
        "optional": false,
        "description": "Name of the filter",
        "restrictions": null
      },
      {
        "name": "filterEnabled",
        "type": "Boolean",
        "optional": false,
        "description": "New enable state of the filter",
        "restrictions": null
      }
    ]
  },
  "GetVersion": {
    "category": "general",
    "complexity": 1,
    "description": "Gets data about the current plugin and RPC version.",
    "fields": []
  },
  "GetStats": {
    "category": "general",
    "complexity": 2,
    "description": "Gets statistics about OBS, obs-websocket, and the current session.",
    "fields": []
  },
  "BroadcastCustomEvent": {
    "category": "general",
    "complexity": 1,
    "description": "Broadcasts a `CustomEvent` to all WebSocket clients. Receivers are clients which are identified and subscribed.",
    "fields": [
      {
        "name": "eventData",
        "type": "Object",
        "optional": false,
        "description": "Data payload to emit to all receivers",
        "restrictions": null
      }
    ]
  },
  "CallVendorRequest": {
    "category": "general",
    "complexity": 3,
    "description": "Call a request registered to a vendor.",
    "fields": [
      {
        "name": "vendorName",
        "type": "String",
        "optional": false,
        "description": "Name of the vendor to use",
        "restrictions": null
      },
      {
        "name": "requestType",
        "type": "String",
        "optional": false,
        "description": "The request type to call",
        "restrictions": null
      },
      {
        "name": "requestData",
        "type": "Object",
        "optional": true,
        "description": "Object containing appropriate request data",
        "restrictions": null
      }
    ]
  },
  "GetHotkeyList": {
    "category": "general",
    "complexity": 4,
    "description": "Gets an array of all hotkey names in OBS.",
    "fields": []
  },
  "TriggerHotkeyByName": {
    "category": "general",
    "complexity": 4,
    "description": "Triggers a hotkey using its name. See `GetHotkeyList`.",
    "fields": [
      {
        "name": "hotkeyName",
        "type": "String",
        "optional": false,
        "description": "Name of the hotkey to trigger",
        "restrictions": null
      },
      {
        "name": "contextName",
        "type": "String",
        "optional": true,
        "description": "Name of context of the hotkey to trigger",
        "restrictions": null
      }
    ]
  },
  "TriggerHotkeyByKeySequence": {
    "category": "general",
    "complexity": 4,
    "description": "Triggers a hotkey using a sequence of keys.",
    "fields": [
      {
        "name": "keyId",
        "type": "String",
        "optional": true,
        "description": "The OBS key ID to use. See https://github.com/obsproject/obs-studio/blob/master/libobs/obs-hotkeys.h",
        "restrictions": null
      },
      {
        "name": "keyModifiers",
        "type": "Object",
        "optional": true,
        "description": "Object containing key modifiers to apply",
        "restrictions": null
      },
      {
        "name": "keyModifiers.shift",
        "type": "Boolean",
        "optional": true,
        "description": "Press Shift",
        "restrictions": null
      },
      {
        "name": "keyModifiers.control",
        "type": "Boolean",
        "optional": true,
        "description": "Press CTRL",
        "restrictions": null
      },
      {
        "name": "keyModifiers.alt",
        "type": "Boolean",
        "optional": true,
        "description": "Press ALT",
        "restrictions": null
      },
      {
        "name": "keyModifiers.command",
        "type": "Boolean",
        "optional": true,
        "description": "Press CMD (Mac)",
        "restrictions": null
      }
    ]
  },
  "Sleep": {
    "category": "general",
    "complexity": 2,
    "description": "Sleeps for a time duration or number of frames. Only available in request batches with types `SERIAL_REALTIME` or `SERIAL_FRAME`.",
    "fields": [
      {
        "name": "sleepMillis",
        "type": "Number",
        "optional": true,
        "description": "Number of milliseconds to sleep for (if `SERIAL_REALTIME` mode)",
        "restrictions": ">= 0, <= 50000"
      },
      {
        "name": "sleepFrames",
        "type": "Number",
        "optional": true,
        "description": "Number of frames to sleep for (if `SERIAL_FRAME` mode)",
        "restrictions": ">= 0, <= 10000"
      }
    ]
  },
  "GetInputList": {
    "category": "inputs",
    "complexity": 2,
    "description": "Gets an array of all inputs in OBS.",
    "fields": [
      {
        "name": "inputKind",
        "type": "String",
        "optional": true,
        "description": "Restrict the array to only inputs of the specified kind",
        "restrictions": null
      }
    ]
  },
  "GetInputKindList": {
    "category": "inputs",
    "complexity": 2,
    "description": "Gets an array of all available input kinds in OBS.",
    "fields": [
      {
        "name": "unversioned",
        "type": "Boolean",
        "optional": true,
        "description": "True == Return all kinds as unversioned, False == Return with version suffixes (if available)",
        "restrictions": null
      }
    ]
  },
  "GetSpecialInputs": {
    "category": "inputs",
    "complexity": 2,
    "description": "Gets the names of all special inputs.",
    "fields": []
  },
  "CreateInput": {
    "category": "inputs",
    "complexity": 3,
    "description": "Creates a new input, adding it as a scene item to the specified scene.",
    "fields": [
      {
        "name": "canvasUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the canvas the scene is in, if using the sceneName field",
        "restrictions": null
      },
      {
        "name": "sceneName",
        "type": "String",
        "optional": true,
        "description": "Name of the scene to add the input to as a scene item",
        "restrictions": null
      },
      {
        "name": "sceneUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the scene to add the input to as a scene item",
        "restrictions": null
      },
      {
        "name": "inputName",
        "type": "String",
        "optional": false,
        "description": "Name of the new input to created",
        "restrictions": null
      },
      {
        "name": "inputKind",
        "type": "String",
        "optional": false,
        "description": "The kind of input to be created",
        "restrictions": null
      },
      {
        "name": "inputSettings",
        "type": "Object",
        "optional": true,
        "description": "Settings object to initialize the input with",
        "restrictions": null
      },
      {
        "name": "sceneItemEnabled",
        "type": "Boolean",
        "optional": true,
        "description": "Whether to set the created scene item to enabled or disabled",
        "restrictions": null
      }
    ]
  },
  "RemoveInput": {
    "category": "inputs",
    "complexity": 2,
    "description": "Removes an existing input.",
    "fields": [
      {
        "name": "inputName",
        "type": "String",
        "optional": true,
        "description": "Name of the input to remove",
        "restrictions": null
      },
      {
        "name": "inputUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the input to remove",
        "restrictions": null
      }
    ]
  },
  "SetInputName": {
    "category": "inputs",
    "complexity": 2,
    "description": "Sets the name of an input (rename).",
    "fields": [
      {
        "name": "inputName",
        "type": "String",
        "optional": true,
        "description": "Current input name",
        "restrictions": null
      },
      {
        "name": "inputUuid",
        "type": "String",
        "optional": true,
        "description": "Current input UUID",
        "restrictions": null
      },
      {
        "name": "newInputName",
        "type": "String",
        "optional": false,
        "description": "New name for the input",
        "restrictions": null
      }
    ]
  },
  "GetInputDefaultSettings": {
    "category": "inputs",
    "complexity": 3,
    "description": "Gets the default settings for an input kind.",
    "fields": [
      {
        "name": "inputKind",
        "type": "String",
        "optional": false,
        "description": "Input kind to get the default settings for",
        "restrictions": null
      }
    ]
  },
  "GetInputSettings": {
    "category": "inputs",
    "complexity": 3,
    "description": "Gets the settings of an input.",
    "fields": [
      {
        "name": "inputName",
        "type": "String",
        "optional": true,
        "description": "Name of the input to get the settings of",
        "restrictions": null
      },
      {
        "name": "inputUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the input to get the settings of",
        "restrictions": null
      }
    ]
  },
  "SetInputSettings": {
    "category": "inputs",
    "complexity": 3,
    "description": "Sets the settings of an input.",
    "fields": [
      {
        "name": "inputName",
        "type": "String",
        "optional": true,
        "description": "Name of the input to set the settings of",
        "restrictions": null
      },
      {
        "name": "inputUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the input to set the settings of",
        "restrictions": null
      },
      {
        "name": "inputSettings",
        "type": "Object",
        "optional": false,
        "description": "Object of settings to apply",
        "restrictions": null
      },
      {
        "name": "overlay",
        "type": "Boolean",
        "optional": true,
        "description": "True == apply the settings on top of existing ones, False == reset the input to its defaults, then apply settings.",
        "restrictions": null
      }
    ]
  },
  "GetInputMute": {
    "category": "inputs",
    "complexity": 2,
    "description": "Gets the audio mute state of an input.",
    "fields": [
      {
        "name": "inputName",
        "type": "String",
        "optional": true,
        "description": "Name of input to get the mute state of",
        "restrictions": null
      },
      {
        "name": "inputUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of input to get the mute state of",
        "restrictions": null
      }
    ]
  },
  "SetInputMute": {
    "category": "inputs",
    "complexity": 2,
    "description": "Sets the audio mute state of an input.",
    "fields": [
      {
        "name": "inputName",
        "type": "String",
        "optional": true,
        "description": "Name of the input to set the mute state of",
        "restrictions": null
      },
      {
        "name": "inputUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the input to set the mute state of",
        "restrictions": null
      },
      {
        "name": "inputMuted",
        "type": "Boolean",
        "optional": false,
        "description": "Whether to mute the input or not",
        "restrictions": null
      }
    ]
  },
  "ToggleInputMute": {
    "category": "inputs",
    "complexity": 2,
    "description": "Toggles the audio mute state of an input.",
    "fields": [
      {
        "name": "inputName",
        "type": "String",
        "optional": true,
        "description": "Name of the input to toggle the mute state of",
        "restrictions": null
      },
      {
        "name": "inputUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the input to toggle the mute state of",
        "restrictions": null
      }
    ]
  },
  "GetInputVolume": {
    "category": "inputs",
    "complexity": 3,
    "description": "Gets the current volume setting of an input.",
    "fields": [
      {
        "name": "inputName",
        "type": "String",
        "optional": true,
        "description": "Name of the input to get the volume of",
        "restrictions": null
      },
      {
        "name": "inputUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the input to get the volume of",
        "restrictions": null
      }
    ]
  },
  "SetInputVolume": {
    "category": "inputs",
    "complexity": 3,
    "description": "Sets the volume setting of an input.",
    "fields": [
      {
        "name": "inputName",
        "type": "String",
        "optional": true,
        "description": "Name of the input to set the volume of",
        "restrictions": null
      },
      {
        "name": "inputUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the input to set the volume of",
        "restrictions": null
      },
      {
        "name": "inputVolumeMul",
        "type": "Number",
        "optional": true,
        "description": "Volume setting in mul",
        "restrictions": ">= 0, <= 20"
      },
      {
        "name": "inputVolumeDb",
        "type": "Number",
        "optional": true,
        "description": "Volume setting in dB",
        "restrictions": ">= -100, <= 26"
      }
    ]
  },
  "GetInputAudioBalance": {
    "category": "inputs",
    "complexity": 2,
    "description": "Gets the audio balance of an input.",
    "fields": [
      {
        "name": "inputName",
        "type": "String",
        "optional": true,
        "description": "Name of the input to get the audio balance of",
        "restrictions": null
      },
      {
        "name": "inputUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the input to get the audio balance of",
        "restrictions": null
      }
    ]
  },
  "SetInputAudioBalance": {
    "category": "inputs",
    "complexity": 2,
    "description": "Sets the audio balance of an input.",
    "fields": [
      {
        "name": "inputName",
        "type": "String",
        "optional": true,
        "description": "Name of the input to set the audio balance of",
        "restrictions": null
      },
      {
        "name": "inputUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the input to set the audio balance of",
        "restrictions": null
      },
      {
        "name": "inputAudioBalance",
        "type": "Number",
        "optional": false,
        "description": "New audio balance value",
        "restrictions": ">= 0.0, <= 1.0"
      }
    ]
  },
  "GetInputAudioSyncOffset": {
    "category": "inputs",
    "complexity": 3,
    "description": "Gets the audio sync offset of an input.",
    "fields": [
      {
        "name": "inputName",
        "type": "String",
        "optional": true,
        "description": "Name of the input to get the audio sync offset of",
        "restrictions": null
      },
      {
        "name": "inputUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the input to get the audio sync offset of",
        "restrictions": null
      }
    ]
  },
  "SetInputAudioSyncOffset": {
    "category": "inputs",
    "complexity": 3,
    "description": "Sets the audio sync offset of an input.",
    "fields": [
      {
        "name": "inputName",
        "type": "String",
        "optional": true,
        "description": "Name of the input to set the audio sync offset of",
        "restrictions": null
      },
      {
        "name": "inputUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the input to set the audio sync offset of",
        "restrictions": null
      },
      {
        "name": "inputAudioSyncOffset",
        "type": "Number",
        "optional": false,
        "description": "New audio sync offset in milliseconds",
        "restrictions": ">= -950, <= 20000"
      }
    ]
  },
  "GetInputAudioMonitorType": {
    "category": "inputs",
    "complexity": 2,
    "description": "Gets the audio monitor type of an input.",
    "fields": [
      {
        "name": "inputName",
        "type": "String",
        "optional": true,
        "description": "Name of the input to get the audio monitor type of",
        "restrictions": null
      },
      {
        "name": "inputUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the input to get the audio monitor type of",
        "restrictions": null
      }
    ]
  },
  "SetInputAudioMonitorType": {
    "category": "inputs",
    "complexity": 2,
    "description": "Sets the audio monitor type of an input.",
    "fields": [
      {
        "name": "inputName",
        "type": "String",
        "optional": true,
        "description": "Name of the input to set the audio monitor type of",
        "restrictions": null
      },
      {
        "name": "inputUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the input to set the audio monitor type of",
        "restrictions": null
      },
      {
        "name": "monitorType",
        "type": "String",
        "optional": false,
        "description": "Audio monitor type",
        "restrictions": null
      }
    ]
  },
  "GetInputAudioTracks": {
    "category": "inputs",
    "complexity": 2,
    "description": "Gets the enable state of all audio tracks of an input.",
    "fields": [
      {
        "name": "inputName",
        "type": "String",
        "optional": true,
        "description": "Name of the input",
        "restrictions": null
      },
      {
        "name": "inputUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the input",
        "restrictions": null
      }
    ]
  },
  "SetInputAudioTracks": {
    "category": "inputs",
    "complexity": 2,
    "description": "Sets the enable state of audio tracks of an input.",
    "fields": [
      {
        "name": "inputName",
        "type": "String",
        "optional": true,
        "description": "Name of the input",
        "restrictions": null
      },
      {
        "name": "inputUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the input",
        "restrictions": null
      },
      {
        "name": "inputAudioTracks",
        "type": "Object",
        "optional": false,
        "description": "Track settings to apply",
        "restrictions": null
      }
    ]
  },
  "GetInputDeinterlaceMode": {
    "category": "inputs",
    "complexity": 2,
    "description": "Gets the deinterlace mode of an input.",
    "fields": [
      {
        "name": "inputName",
        "type": "String",
        "optional": true,
        "description": "Name of the input",
        "restrictions": null
      },
      {
        "name": "inputUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the input",
        "restrictions": null
      }
    ]
  },
  "SetInputDeinterlaceMode": {
    "category": "inputs",
    "complexity": 2,
    "description": "Sets the deinterlace mode of an input.",
    "fields": [
      {
        "name": "inputName",
        "type": "String",
        "optional": true,
        "description": "Name of the input",
        "restrictions": null
      },
      {
        "name": "inputUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the input",
        "restrictions": null
      },
      {
        "name": "inputDeinterlaceMode",
        "type": "String",
        "optional": false,
        "description": "Deinterlace mode for the input",
        "restrictions": null
      }
    ]
  },
  "GetInputDeinterlaceFieldOrder": {
    "category": "inputs",
    "complexity": 2,
    "description": "Gets the deinterlace field order of an input.",
    "fields": [
      {
        "name": "inputName",
        "type": "String",
        "optional": true,
        "description": "Name of the input",
        "restrictions": null
      },
      {
        "name": "inputUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the input",
        "restrictions": null
      }
    ]
  },
  "SetInputDeinterlaceFieldOrder": {
    "category": "inputs",
    "complexity": 2,
    "description": "Sets the deinterlace field order of an input.",
    "fields": [
      {
        "name": "inputName",
        "type": "String",
        "optional": true,
        "description": "Name of the input",
        "restrictions": null
      },
      {
        "name": "inputUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the input",
        "restrictions": null
      },
      {
        "name": "inputDeinterlaceFieldOrder",
        "type": "String",
        "optional": false,
        "description": "Deinterlace field order for the input",
        "restrictions": null
      }
    ]
  },
  "GetInputPropertiesListPropertyItems": {
    "category": "inputs",
    "complexity": 4,
    "description": "Gets the items of a list property from an input's properties.",
    "fields": [
      {
        "name": "inputName",
        "type": "String",
        "optional": true,
        "description": "Name of the input",
        "restrictions": null
      },
      {
        "name": "inputUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the input",
        "restrictions": null
      },
      {
        "name": "propertyName",
        "type": "String",
        "optional": false,
        "description": "Name of the list property to get the items of",
        "restrictions": null
      }
    ]
  },
  "PressInputPropertiesButton": {
    "category": "inputs",
    "complexity": 4,
    "description": "Presses a button in the properties of an input.",
    "fields": [
      {
        "name": "inputName",
        "type": "String",
        "optional": true,
        "description": "Name of the input",
        "restrictions": null
      },
      {
        "name": "inputUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the input",
        "restrictions": null
      },
      {
        "name": "propertyName",
        "type": "String",
        "optional": false,
        "description": "Name of the button property to press",
        "restrictions": null
      }
    ]
  },
  "GetMediaInputStatus": {
    "category": "media inputs",
    "complexity": 2,
    "description": "Gets the status of a media input.",
    "fields": [
      {
        "name": "inputName",
        "type": "String",
        "optional": true,
        "description": "Name of the media input",
        "restrictions": null
      },
      {
        "name": "inputUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the media input",
        "restrictions": null
      }
    ]
  },
  "SetMediaInputCursor": {
    "category": "media inputs",
    "complexity": 2,
    "description": "Sets the cursor position of a media input.",
    "fields": [
      {
        "name": "inputName",
        "type": "String",
        "optional": true,
        "description": "Name of the media input",
        "restrictions": null
      },
      {
        "name": "inputUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the media input",
        "restrictions": null
      },
      {
        "name": "mediaCursor",
        "type": "Number",
        "optional": false,
        "description": "New cursor position to set",
        "restrictions": ">= 0"
      }
    ]
  },
  "OffsetMediaInputCursor": {
    "category": "media inputs",
    "complexity": 2,
    "description": "Offsets the current cursor position of a media input by the specified value.",
    "fields": [
      {
        "name": "inputName",
        "type": "String",
        "optional": true,
        "description": "Name of the media input",
        "restrictions": null
      },
      {
        "name": "inputUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the media input",
        "restrictions": null
      },
      {
        "name": "mediaCursorOffset",
        "type": "Number",
        "optional": false,
        "description": "Value to offset the current cursor position by",
        "restrictions": null
      }
    ]
  },
  "TriggerMediaInputAction": {
    "category": "media inputs",
    "complexity": 2,
    "description": "Triggers an action on a media input.",
    "fields": [
      {
        "name": "inputName",
        "type": "String",
        "optional": true,
        "description": "Name of the media input",
        "restrictions": null
      },
      {
        "name": "inputUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the media input",
        "restrictions": null
      },
      {
        "name": "mediaAction",
        "type": "String",
        "optional": false,
        "description": "Identifier of the `ObsMediaInputAction` enum",
        "restrictions": null
      }
    ]
  },
  "GetVirtualCamStatus": {
    "category": "outputs",
    "complexity": 1,
    "description": "Gets the status of the virtualcam output.",
    "fields": []
  },
  "ToggleVirtualCam": {
    "category": "outputs",
    "complexity": 1,
    "description": "Toggles the state of the virtualcam output.",
    "fields": []
  },
  "StartVirtualCam": {
    "category": "outputs",
    "complexity": 1,
    "description": "Starts the virtualcam output.",
    "fields": []
  },
  "StopVirtualCam": {
    "category": "outputs",
    "complexity": 1,
    "description": "Stops the virtualcam output.",
    "fields": []
  },
  "GetReplayBufferStatus": {
    "category": "outputs",
    "complexity": 1,
    "description": "Gets the status of the replay buffer output.",
    "fields": []
  },
  "ToggleReplayBuffer": {
    "category": "outputs",
    "complexity": 1,
    "description": "Toggles the state of the replay buffer output.",
    "fields": []
  },
  "StartReplayBuffer": {
    "category": "outputs",
    "complexity": 1,
    "description": "Starts the replay buffer output.",
    "fields": []
  },
  "StopReplayBuffer": {
    "category": "outputs",
    "complexity": 1,
    "description": "Stops the replay buffer output.",
    "fields": []
  },
  "SaveReplayBuffer": {
    "category": "outputs",
    "complexity": 1,
    "description": "Saves the contents of the replay buffer output.",
    "fields": []
  },
  "GetLastReplayBufferReplay": {
    "category": "outputs",
    "complexity": 2,
    "description": "Gets the filename of the last replay buffer save file.",
    "fields": []
  },
  "GetOutputList": {
    "category": "outputs",
    "complexity": 4,
    "description": "Gets the list of available outputs.",
    "fields": []
  },
  "GetOutputStatus": {
    "category": "outputs",
    "complexity": 4,
    "description": "Gets the status of an output.",
    "fields": [
      {
        "name": "outputName",
        "type": "String",
        "optional": false,
        "description": "Output name",
        "restrictions": null
      }
    ]
  },
  "ToggleOutput": {
    "category": "outputs",
    "complexity": 4,
    "description": "Toggles the status of an output.",
    "fields": [
      {
        "name": "outputName",
        "type": "String",
        "optional": false,
        "description": "Output name",
        "restrictions": null
      }
    ]
  },
  "StartOutput": {
    "category": "outputs",
    "complexity": 4,
    "description": "Starts an output.",
    "fields": [
      {
        "name": "outputName",
        "type": "String",
        "optional": false,
        "description": "Output name",
        "restrictions": null
      }
    ]
  },
  "StopOutput": {
    "category": "outputs",
    "complexity": 4,
    "description": "Stops an output.",
    "fields": [
      {
        "name": "outputName",
        "type": "String",
        "optional": false,
        "description": "Output name",
        "restrictions": null
      }
    ]
  },
  "GetOutputSettings": {
    "category": "outputs",
    "complexity": 4,
    "description": "Gets the settings of an output.",
    "fields": [
      {
        "name": "outputName",
        "type": "String",
        "optional": false,
        "description": "Output name",
        "restrictions": null
      }
    ]
  },
  "SetOutputSettings": {
    "category": "outputs",
    "complexity": 4,
    "description": "Sets the settings of an output.",
    "fields": [
      {
        "name": "outputName",
        "type": "String",
        "optional": false,
        "description": "Output name",
        "restrictions": null
      },
      {
        "name": "outputSettings",
        "type": "Object",
        "optional": false,
        "description": "Output settings",
        "restrictions": null
      }
    ]
  },
  "GetRecordStatus": {
    "category": "record",
    "complexity": 2,
    "description": "Gets the status of the record output.",
    "fields": []
  },
  "ToggleRecord": {
    "category": "record",
    "complexity": 1,
    "description": "Toggles the status of the record output.",
    "fields": []
  },
  "StartRecord": {
    "category": "record",
    "complexity": 1,
    "description": "Starts the record output.",
    "fields": []
  },
  "StopRecord": {
    "category": "record",
    "complexity": 1,
    "description": "Stops the record output.",
    "fields": []
  },
  "ToggleRecordPause": {
    "category": "record",
    "complexity": 1,
    "description": "Toggles pause on the record output.",
    "fields": []
  },
  "PauseRecord": {
    "category": "record",
    "complexity": 1,
    "description": "Pauses the record output.",
    "fields": []
  },
  "ResumeRecord": {
    "category": "record",
    "complexity": 1,
    "description": "Resumes the record output.",
    "fields": []
  },
  "SplitRecordFile": {
    "category": "record",
    "complexity": 2,
    "description": "Splits the current file being recorded into a new file.",
    "fields": []
  },
  "CreateRecordChapter": {
    "category": "record",
    "complexity": 2,
    "description": "Adds a new chapter marker to the file currently being recorded.",
    "fields": [
      {
        "name": "chapterName",
        "type": "String",
        "optional": true,
        "description": "Name of the new chapter",
        "restrictions": null
      }
    ]
  },
  "GetSceneItemList": {
    "category": "scene items",
    "complexity": 3,
    "description": "Gets a list of all scene items in a scene.",
    "fields": [
      {
        "name": "canvasUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the canvas the scene is in, if using the sceneName field",
        "restrictions": null
      },
      {
        "name": "sceneName",
        "type": "String",
        "optional": true,
        "description": "Name of the scene to get the items of",
        "restrictions": null
      },
      {
        "name": "sceneUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the scene to get the items of",
        "restrictions": null
      }
    ]
  },
  "GetGroupSceneItemList": {
    "category": "scene items",
    "complexity": 3,
    "description": "Basically GetSceneItemList, but for groups.",
    "fields": [
      {
        "name": "canvasUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the canvas the group is in, if using the sceneName field",
        "restrictions": null
      },
      {
        "name": "sceneName",
        "type": "String",
        "optional": true,
        "description": "Name of the group to get the items of",
        "restrictions": null
      },
      {
        "name": "sceneUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the group to get the items of",
        "restrictions": null
      }
    ]
  },
  "GetSceneItemId": {
    "category": "scene items",
    "complexity": 3,
    "description": "Searches a scene for a source, and returns its id.",
    "fields": [
      {
        "name": "canvasUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the canvas the scene or group is in, if using the sceneName field",
        "restrictions": null
      },
      {
        "name": "sceneName",
        "type": "String",
        "optional": true,
        "description": "Name of the scene or group to search in",
        "restrictions": null
      },
      {
        "name": "sceneUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the scene or group to search in",
        "restrictions": null
      },
      {
        "name": "sourceName",
        "type": "String",
        "optional": false,
        "description": "Name of the source to find",
        "restrictions": null
      },
      {
        "name": "searchOffset",
        "type": "Number",
        "optional": true,
        "description": "Number of matches to skip during search. >= 0 means first forward. -1 means last (top) item",
        "restrictions": ">= -1"
      }
    ]
  },
  "GetSceneItemSource": {
    "category": "scene items",
    "complexity": 3,
    "description": "Gets the source associated with a scene item.",
    "fields": [
      {
        "name": "canvasUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the canvas the scene is in, if using the sceneName field",
        "restrictions": null
      },
      {
        "name": "sceneName",
        "type": "String",
        "optional": true,
        "description": "Name of the scene the item is in",
        "restrictions": null
      },
      {
        "name": "sceneUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the scene the item is in",
        "restrictions": null
      },
      {
        "name": "sceneItemId",
        "type": "Number",
        "optional": false,
        "description": "Numeric ID of the scene item",
        "restrictions": ">= 0"
      }
    ]
  },
  "CreateSceneItem": {
    "category": "scene items",
    "complexity": 3,
    "description": "Creates a new scene item using a source.",
    "fields": [
      {
        "name": "canvasUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the canvas the scene is in, if using the sceneName field",
        "restrictions": null
      },
      {
        "name": "sceneName",
        "type": "String",
        "optional": true,
        "description": "Name of the scene to create the new item in",
        "restrictions": null
      },
      {
        "name": "sceneUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the scene to create the new item in",
        "restrictions": null
      },
      {
        "name": "sourceName",
        "type": "String",
        "optional": true,
        "description": "Name of the source to add to the scene",
        "restrictions": null
      },
      {
        "name": "sourceUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the source to add to the scene",
        "restrictions": null
      },
      {
        "name": "sceneItemEnabled",
        "type": "Boolean",
        "optional": true,
        "description": "Enable state to apply to the scene item on creation",
        "restrictions": null
      }
    ]
  },
  "RemoveSceneItem": {
    "category": "scene items",
    "complexity": 3,
    "description": "Removes a scene item from a scene.",
    "fields": [
      {
        "name": "canvasUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the canvas the scene is in, if using the sceneName field",
        "restrictions": null
      },
      {
        "name": "sceneName",
        "type": "String",
        "optional": true,
        "description": "Name of the scene the item is in",
        "restrictions": null
      },
      {
        "name": "sceneUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the scene the item is in",
        "restrictions": null
      },
      {
        "name": "sceneItemId",
        "type": "Number",
        "optional": false,
        "description": "Numeric ID of the scene item",
        "restrictions": ">= 0"
      }
    ]
  },
  "DuplicateSceneItem": {
    "category": "scene items",
    "complexity": 3,
    "description": "Duplicates a scene item, copying all transform and crop info.",
    "fields": [
      {
        "name": "canvasUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the canvas the scene is in, if using the sceneName field",
        "restrictions": null
      },
      {
        "name": "sceneName",
        "type": "String",
        "optional": true,
        "description": "Name of the scene the item is in",
        "restrictions": null
      },
      {
        "name": "sceneUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the scene the item is in",
        "restrictions": null
      },
      {
        "name": "sceneItemId",
        "type": "Number",
        "optional": false,
        "description": "Numeric ID of the scene item",
        "restrictions": ">= 0"
      },
      {
        "name": "destinationSceneName",
        "type": "String",
        "optional": true,
        "description": "Name of the scene to create the duplicated item in",
        "restrictions": null
      },
      {
        "name": "destinationSceneUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the scene to create the duplicated item in",
        "restrictions": null
      }
    ]
  },
  "GetSceneItemTransform": {
    "category": "scene items",
    "complexity": 3,
    "description": "Gets the transform and crop info of a scene item.",
    "fields": [
      {
        "name": "canvasUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the canvas the scene is in, if using the sceneName field",
        "restrictions": null
      },
      {
        "name": "sceneName",
        "type": "String",
        "optional": true,
        "description": "Name of the scene the item is in",
        "restrictions": null
      },
      {
        "name": "sceneUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the scene the item is in",
        "restrictions": null
      },
      {
        "name": "sceneItemId",
        "type": "Number",
        "optional": false,
        "description": "Numeric ID of the scene item",
        "restrictions": ">= 0"
      }
    ]
  },
  "SetSceneItemTransform": {
    "category": "scene items",
    "complexity": 3,
    "description": "Sets the transform and crop info of a scene item.",
    "fields": [
      {
        "name": "canvasUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the canvas the scene is in, if using the sceneName field",
        "restrictions": null
      },
      {
        "name": "sceneName",
        "type": "String",
        "optional": true,
        "description": "Name of the scene the item is in",
        "restrictions": null
      },
      {
        "name": "sceneUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the scene the item is in",
        "restrictions": null
      },
      {
        "name": "sceneItemId",
        "type": "Number",
        "optional": false,
        "description": "Numeric ID of the scene item",
        "restrictions": ">= 0"
      },
      {
        "name": "sceneItemTransform",
        "type": "Object",
        "optional": false,
        "description": "Object containing scene item transform info to update",
        "restrictions": null
      }
    ]
  },
  "GetSceneItemEnabled": {
    "category": "scene items",
    "complexity": 3,
    "description": "Gets the enable state of a scene item.",
    "fields": [
      {
        "name": "canvasUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the canvas the scene is in, if using the sceneName field",
        "restrictions": null
      },
      {
        "name": "sceneName",
        "type": "String",
        "optional": true,
        "description": "Name of the scene the item is in",
        "restrictions": null
      },
      {
        "name": "sceneUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the scene the item is in",
        "restrictions": null
      },
      {
        "name": "sceneItemId",
        "type": "Number",
        "optional": false,
        "description": "Numeric ID of the scene item",
        "restrictions": ">= 0"
      }
    ]
  },
  "SetSceneItemEnabled": {
    "category": "scene items",
    "complexity": 3,
    "description": "Sets the enable state of a scene item.",
    "fields": [
      {
        "name": "canvasUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the canvas the scene is in, if using the sceneName field",
        "restrictions": null
      },
      {
        "name": "sceneName",
        "type": "String",
        "optional": true,
        "description": "Name of the scene the item is in",
        "restrictions": null
      },
      {
        "name": "sceneUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the scene the item is in",
        "restrictions": null
      },
      {
        "name": "sceneItemId",
        "type": "Number",
        "optional": false,
        "description": "Numeric ID of the scene item",
        "restrictions": ">= 0"
      },
      {
        "name": "sceneItemEnabled",
        "type": "Boolean",
        "optional": false,
        "description": "New enable state of the scene item",
        "restrictions": null
      }
    ]
  },
  "GetSceneItemLocked": {
    "category": "scene items",
    "complexity": 3,
    "description": "Gets the lock state of a scene item.",
    "fields": [
      {
        "name": "canvasUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the canvas the scene is in, if using the sceneName field",
        "restrictions": null
      },
      {
        "name": "sceneName",
        "type": "String",
        "optional": true,
        "description": "Name of the scene the item is in",
        "restrictions": null
      },
      {
        "name": "sceneUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the scene the item is in",
        "restrictions": null
      },
      {
        "name": "sceneItemId",
        "type": "Number",
        "optional": false,
        "description": "Numeric ID of the scene item",
        "restrictions": ">= 0"
      }
    ]
  },
  "SetSceneItemLocked": {
    "category": "scene items",
    "complexity": 3,
    "description": "Sets the lock state of a scene item.",
    "fields": [
      {
        "name": "canvasUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the canvas the scene is in, if using the sceneName field",
        "restrictions": null
      },
      {
        "name": "sceneName",
        "type": "String",
        "optional": true,
        "description": "Name of the scene the item is in",
        "restrictions": null
      },
      {
        "name": "sceneUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the scene the item is in",
        "restrictions": null
      },
      {
        "name": "sceneItemId",
        "type": "Number",
        "optional": false,
        "description": "Numeric ID of the scene item",
        "restrictions": ">= 0"
      },
      {
        "name": "sceneItemLocked",
        "type": "Boolean",
        "optional": false,
        "description": "New lock state of the scene item",
        "restrictions": null
      }
    ]
  },
  "GetSceneItemIndex": {
    "category": "scene items",
    "complexity": 3,
    "description": "Gets the index position of a scene item in a scene.",
    "fields": [
      {
        "name": "canvasUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the canvas the scene is in, if using the sceneName field",
        "restrictions": null
      },
      {
        "name": "sceneName",
        "type": "String",
        "optional": true,
        "description": "Name of the scene the item is in",
        "restrictions": null
      },
      {
        "name": "sceneUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the scene the item is in",
        "restrictions": null
      },
      {
        "name": "sceneItemId",
        "type": "Number",
        "optional": false,
        "description": "Numeric ID of the scene item",
        "restrictions": ">= 0"
      }
    ]
  },
  "SetSceneItemIndex": {
    "category": "scene items",
    "complexity": 3,
    "description": "Sets the index position of a scene item in a scene.",
    "fields": [
      {
        "name": "canvasUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the canvas the scene is in, if using the sceneName field",
        "restrictions": null
      },
      {
        "name": "sceneName",
        "type": "String",
        "optional": true,
        "description": "Name of the scene the item is in",
        "restrictions": null
      },
      {
        "name": "sceneUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the scene the item is in",
        "restrictions": null
      },
      {
        "name": "sceneItemId",
        "type": "Number",
        "optional": false,
        "description": "Numeric ID of the scene item",
        "restrictions": ">= 0"
      },
      {
        "name": "sceneItemIndex",
        "type": "Number",
        "optional": false,
        "description": "New index position of the scene item",
        "restrictions": ">= 0"
      }
    ]
  },
  "GetSceneItemBlendMode": {
    "category": "scene items",
    "complexity": 2,
    "description": "Gets the blend mode of a scene item.",
    "fields": [
      {
        "name": "canvasUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the canvas the scene is in, if using the sceneName field",
        "restrictions": null
      },
      {
        "name": "sceneName",
        "type": "String",
        "optional": true,
        "description": "Name of the scene the item is in",
        "restrictions": null
      },
      {
        "name": "sceneUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the scene the item is in",
        "restrictions": null
      },
      {
        "name": "sceneItemId",
        "type": "Number",
        "optional": false,
        "description": "Numeric ID of the scene item",
        "restrictions": ">= 0"
      }
    ]
  },
  "SetSceneItemBlendMode": {
    "category": "scene items",
    "complexity": 2,
    "description": "Sets the blend mode of a scene item.",
    "fields": [
      {
        "name": "canvasUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the canvas the scene is in, if using the sceneName field",
        "restrictions": null
      },
      {
        "name": "sceneName",
        "type": "String",
        "optional": true,
        "description": "Name of the scene the item is in",
        "restrictions": null
      },
      {
        "name": "sceneUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the scene the item is in",
        "restrictions": null
      },
      {
        "name": "sceneItemId",
        "type": "Number",
        "optional": false,
        "description": "Numeric ID of the scene item",
        "restrictions": ">= 0"
      },
      {
        "name": "sceneItemBlendMode",
        "type": "String",
        "optional": false,
        "description": "New blend mode",
        "restrictions": null
      }
    ]
  },
  "GetSceneList": {
    "category": "scenes",
    "complexity": 2,
    "description": "Gets an array of scenes in OBS.",
    "fields": [
      {
        "name": "canvasUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the canvas the scenes are in",
        "restrictions": null
      }
    ]
  },
  "GetGroupList": {
    "category": "scenes",
    "complexity": 2,
    "description": "Gets an array of all groups in OBS.",
    "fields": []
  },
  "GetCurrentProgramScene": {
    "category": "scenes",
    "complexity": 1,
    "description": "Gets the current program scene.",
    "fields": []
  },
  "SetCurrentProgramScene": {
    "category": "scenes",
    "complexity": 1,
    "description": "Sets the current program scene.",
    "fields": [
      {
        "name": "sceneName",
        "type": "String",
        "optional": true,
        "description": "Scene name to set as the current program scene",
        "restrictions": null
      },
      {
        "name": "sceneUuid",
        "type": "String",
        "optional": true,
        "description": "Scene UUID to set as the current program scene",
        "restrictions": null
      }
    ]
  },
  "GetCurrentPreviewScene": {
    "category": "scenes",
    "complexity": 1,
    "description": "Gets the current preview scene.",
    "fields": []
  },
  "SetCurrentPreviewScene": {
    "category": "scenes",
    "complexity": 1,
    "description": "Sets the current preview scene.",
    "fields": [
      {
        "name": "sceneName",
        "type": "String",
        "optional": true,
        "description": "Scene name to set as the current preview scene",
        "restrictions": null
      },
      {
        "name": "sceneUuid",
        "type": "String",
        "optional": true,
        "description": "Scene UUID to set as the current preview scene",
        "restrictions": null
      }
    ]
  },
  "CreateScene": {
    "category": "scenes",
    "complexity": 2,
    "description": "Creates a new scene in OBS.",
    "fields": [
      {
        "name": "canvasUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the canvas to create the new scene in. Leave default to assume main canvas",
        "restrictions": null
      },
      {
        "name": "sceneName",
        "type": "String",
        "optional": false,
        "description": "Name for the new scene",
        "restrictions": null
      }
    ]
  },
  "RemoveScene": {
    "category": "scenes",
    "complexity": 2,
    "description": "Removes a scene from OBS.",
    "fields": [
      {
        "name": "canvasUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the canvas the scene is in, if using the sceneName field",
        "restrictions": null
      },
      {
        "name": "sceneName",
        "type": "String",
        "optional": true,
        "description": "Name of the scene to remove",
        "restrictions": null
      },
      {
        "name": "sceneUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the scene to remove",
        "restrictions": null
      }
    ]
  },
  "SetSceneName": {
    "category": "scenes",
    "complexity": 2,
    "description": "Sets the name of a scene (rename).",
    "fields": [
      {
        "name": "canvasUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the canvas the scene is in, if using the sceneName field",
        "restrictions": null
      },
      {
        "name": "sceneName",
        "type": "String",
        "optional": true,
        "description": "Name of the scene to be renamed",
        "restrictions": null
      },
      {
        "name": "sceneUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the scene to be renamed",
        "restrictions": null
      },
      {
        "name": "newSceneName",
        "type": "String",
        "optional": false,
        "description": "New name for the scene",
        "restrictions": null
      }
    ]
  },
  "GetSceneSceneTransitionOverride": {
    "category": "scenes",
    "complexity": 2,
    "description": "Gets the scene transition overridden for a scene.",
    "fields": [
      {
        "name": "canvasUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the canvas the scene is in, if using the sceneName field",
        "restrictions": null
      },
      {
        "name": "sceneName",
        "type": "String",
        "optional": true,
        "description": "Name of the scene",
        "restrictions": null
      },
      {
        "name": "sceneUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the scene",
        "restrictions": null
      }
    ]
  },
  "SetSceneSceneTransitionOverride": {
    "category": "scenes",
    "complexity": 2,
    "description": "Sets the scene transition overridden for a scene.",
    "fields": [
      {
        "name": "canvasUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the canvas the scene is in, if using the sceneName field",
        "restrictions": null
      },
      {
        "name": "sceneName",
        "type": "String",
        "optional": true,
        "description": "Name of the scene",
        "restrictions": null
      },
      {
        "name": "sceneUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the scene",
        "restrictions": null
      },
      {
        "name": "transitionName",
        "type": "String",
        "optional": true,
        "description": "Name of the scene transition to use as override. Specify `null` to remove",
        "restrictions": null
      },
      {
        "name": "transitionDuration",
        "type": "Number",
        "optional": true,
        "description": "Duration to use for any overridden transition. Specify `null` to remove",
        "restrictions": ">= 50, <= 20000"
      }
    ]
  },
  "GetSourceActive": {
    "category": "sources",
    "complexity": 2,
    "description": "Gets the active and show state of a source.",
    "fields": [
      {
        "name": "canvasUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the canvas the source is in, if using sourceName field",
        "restrictions": null
      },
      {
        "name": "sourceName",
        "type": "String",
        "optional": true,
        "description": "Name of the source to get the active state of",
        "restrictions": null
      },
      {
        "name": "sourceUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the source to get the active state of",
        "restrictions": null
      }
    ]
  },
  "GetSourceScreenshot": {
    "category": "sources",
    "complexity": 4,
    "description": "Gets a Base64-encoded screenshot of a source.",
    "fields": [
      {
        "name": "canvasUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the canvas the source is in, if using sourceName field",
        "restrictions": null
      },
      {
        "name": "sourceName",
        "type": "String",
        "optional": true,
        "description": "Name of the source to take a screenshot of",
        "restrictions": null
      },
      {
        "name": "sourceUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the source to take a screenshot of",
        "restrictions": null
      },
      {
        "name": "imageFormat",
        "type": "String",
        "optional": false,
        "description": "Image compression format to use. Use `GetVersion` to get compatible image formats",
        "restrictions": null
      },
      {
        "name": "imageWidth",
        "type": "Number",
        "optional": true,
        "description": "Width to scale the screenshot to",
        "restrictions": ">= 8, <= 4096"
      },
      {
        "name": "imageHeight",
        "type": "Number",
        "optional": true,
        "description": "Height to scale the screenshot to",
        "restrictions": ">= 8, <= 4096"
      },
      {
        "name": "imageCompressionQuality",
        "type": "Number",
        "optional": true,
        "description": "Compression quality to use. 0 for high compression, 100 for uncompressed. -1 to use \"default\" (whatever that means, idk)",
        "restrictions": ">= -1, <= 100"
      }
    ]
  },
  "SaveSourceScreenshot": {
    "category": "sources",
    "complexity": 3,
    "description": "Saves a screenshot of a source to the filesystem.",
    "fields": [
      {
        "name": "canvasUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the canvas the source is in, if using sourceName field",
        "restrictions": null
      },
      {
        "name": "sourceName",
        "type": "String",
        "optional": true,
        "description": "Name of the source to take a screenshot of",
        "restrictions": null
      },
      {
        "name": "sourceUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the source to take a screenshot of",
        "restrictions": null
      },
      {
        "name": "imageFormat",
        "type": "String",
        "optional": false,
        "description": "Image compression format to use. Use `GetVersion` to get compatible image formats",
        "restrictions": null
      },
      {
        "name": "imageFilePath",
        "type": "String",
        "optional": false,
        "description": "Path to save the screenshot file to. Eg. `C:\\Users\\user\\Desktop\\screenshot.png`",
        "restrictions": null
      },
      {
        "name": "imageWidth",
        "type": "Number",
        "optional": true,
        "description": "Width to scale the screenshot to",
        "restrictions": ">= 8, <= 4096"
      },
      {
        "name": "imageHeight",
        "type": "Number",
        "optional": true,
        "description": "Height to scale the screenshot to",
        "restrictions": ">= 8, <= 4096"
      },
      {
        "name": "imageCompressionQuality",
        "type": "Number",
        "optional": true,
        "description": "Compression quality to use. 0 for high compression, 100 for uncompressed. -1 to use \"default\" (whatever that means, idk)",
        "restrictions": ">= -1, <= 100"
      }
    ]
  },
  "GetStreamStatus": {
    "category": "stream",
    "complexity": 2,
    "description": "Gets the status of the stream output.",
    "fields": []
  },
  "ToggleStream": {
    "category": "stream",
    "complexity": 1,
    "description": "Toggles the status of the stream output.",
    "fields": []
  },
  "StartStream": {
    "category": "stream",
    "complexity": 1,
    "description": "Starts the stream output.",
    "fields": []
  },
  "StopStream": {
    "category": "stream",
    "complexity": 1,
    "description": "Stops the stream output.",
    "fields": []
  },
  "SendStreamCaption": {
    "category": "stream",
    "complexity": 2,
    "description": "Sends CEA-608 caption text over the stream output.",
    "fields": [
      {
        "name": "captionText",
        "type": "String",
        "optional": false,
        "description": "Caption text",
        "restrictions": null
      }
    ]
  },
  "GetTransitionKindList": {
    "category": "transitions",
    "complexity": 2,
    "description": "Gets an array of all available transition kinds.",
    "fields": []
  },
  "GetSceneTransitionList": {
    "category": "transitions",
    "complexity": 3,
    "description": "Gets an array of all scene transitions in OBS.",
    "fields": []
  },
  "GetCurrentSceneTransition": {
    "category": "transitions",
    "complexity": 2,
    "description": "Gets information about the current scene transition.",
    "fields": []
  },
  "SetCurrentSceneTransition": {
    "category": "transitions",
    "complexity": 2,
    "description": "Sets the current scene transition.",
    "fields": [
      {
        "name": "transitionName",
        "type": "String",
        "optional": false,
        "description": "Name of the transition to make active",
        "restrictions": null
      }
    ]
  },
  "SetCurrentSceneTransitionDuration": {
    "category": "transitions",
    "complexity": 2,
    "description": "Sets the duration of the current scene transition, if it is not fixed.",
    "fields": [
      {
        "name": "transitionDuration",
        "type": "Number",
        "optional": false,
        "description": "Duration in milliseconds",
        "restrictions": ">= 50, <= 20000"
      }
    ]
  },
  "SetCurrentSceneTransitionSettings": {
    "category": "transitions",
    "complexity": 3,
    "description": "Sets the settings of the current scene transition.",
    "fields": [
      {
        "name": "transitionSettings",
        "type": "Object",
        "optional": false,
        "description": "Settings object to apply to the transition. Can be `{}`",
        "restrictions": null
      },
      {
        "name": "overlay",
        "type": "Boolean",
        "optional": true,
        "description": "Whether to overlay over the current settings or replace them",
        "restrictions": null
      }
    ]
  },
  "GetCurrentSceneTransitionCursor": {
    "category": "transitions",
    "complexity": 2,
    "description": "Gets the cursor position of the current scene transition.",
    "fields": []
  },
  "TriggerStudioModeTransition": {
    "category": "transitions",
    "complexity": 1,
    "description": "Triggers the current scene transition. Same functionality as the `Transition` button in studio mode.",
    "fields": []
  },
  "SetTBarPosition": {
    "category": "transitions",
    "complexity": 3,
    "description": "Sets the position of the TBar.",
    "fields": [
      {
        "name": "position",
        "type": "Number",
        "optional": false,
        "description": "New position",
        "restrictions": ">= 0.0, <= 1.0"
      },
      {
        "name": "release",
        "type": "Boolean",
        "optional": true,
        "description": "Whether to release the TBar. Only set `false` if you know that you will be sending another position update",
        "restrictions": null
      }
    ]
  },
  "GetStudioModeEnabled": {
    "category": "ui",
    "complexity": 1,
    "description": "Gets whether studio is enabled.",
    "fields": []
  },
  "SetStudioModeEnabled": {
    "category": "ui",
    "complexity": 1,
    "description": "Enables or disables studio mode",
    "fields": [
      {
        "name": "studioModeEnabled",
        "type": "Boolean",
        "optional": false,
        "description": "True == Enabled, False == Disabled",
        "restrictions": null
      }
    ]
  },
  "OpenInputPropertiesDialog": {
    "category": "ui",
    "complexity": 1,
    "description": "Opens the properties dialog of an input.",
    "fields": [
      {
        "name": "inputName",
        "type": "String",
        "optional": true,
        "description": "Name of the input to open the dialog of",
        "restrictions": null
      },
      {
        "name": "inputUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the input to open the dialog of",
        "restrictions": null
      }
    ]
  },
  "OpenInputFiltersDialog": {
    "category": "ui",
    "complexity": 1,
    "description": "Opens the filters dialog of an input.",
    "fields": [
      {
        "name": "inputName",
        "type": "String",
        "optional": true,
        "description": "Name of the input to open the dialog of",
        "restrictions": null
      },
      {
        "name": "inputUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the input to open the dialog of",
        "restrictions": null
      }
    ]
  },
  "OpenInputInteractDialog": {
    "category": "ui",
    "complexity": 1,
    "description": "Opens the interact dialog of an input.",
    "fields": [
      {
        "name": "inputName",
        "type": "String",
        "optional": true,
        "description": "Name of the input to open the dialog of",
        "restrictions": null
      },
      {
        "name": "inputUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the input to open the dialog of",
        "restrictions": null
      }
    ]
  },
  "GetMonitorList": {
    "category": "ui",
    "complexity": 2,
    "description": "Gets a list of connected monitors and information about them.",
    "fields": []
  },
  "OpenVideoMixProjector": {
    "category": "ui",
    "complexity": 3,
    "description": "Opens a projector for a specific output video mix.",
    "fields": [
      {
        "name": "videoMixType",
        "type": "String",
        "optional": false,
        "description": "Type of mix to open",
        "restrictions": null
      },
      {
        "name": "monitorIndex",
        "type": "Number",
        "optional": true,
        "description": "Monitor index, use `GetMonitorList` to obtain index",
        "restrictions": null
      },
      {
        "name": "projectorGeometry",
        "type": "String",
        "optional": true,
        "description": "Size/Position data for a windowed projector, in Qt Base64 encoded format. Mutually exclusive with `monitorIndex`",
        "restrictions": null
      }
    ]
  },
  "OpenSourceProjector": {
    "category": "ui",
    "complexity": 3,
    "description": "Opens a projector for a source.",
    "fields": [
      {
        "name": "canvasUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the canvas the source is in, if using the sourceName field",
        "restrictions": null
      },
      {
        "name": "sourceName",
        "type": "String",
        "optional": true,
        "description": "Name of the source to open a projector for",
        "restrictions": null
      },
      {
        "name": "sourceUuid",
        "type": "String",
        "optional": true,
        "description": "UUID of the source to open a projector for",
        "restrictions": null
      },
      {
        "name": "monitorIndex",
        "type": "Number",
        "optional": true,
        "description": "Monitor index, use `GetMonitorList` to obtain index",
        "restrictions": null
      },
      {
        "name": "projectorGeometry",
        "type": "String",
        "optional": true,
        "description": "Size/Position data for a windowed projector, in Qt Base64 encoded format. Mutually exclusive with `monitorIndex`",
        "restrictions": null
      }
    ]
  }
};

/* Event metadata: category and payload field descriptors. */
export const EVENTS = {
  "CanvasCreated": {
    "category": "canvases",
    "description": "A new canvas has been created.",
    "fields": []
  },
  "CanvasRemoved": {
    "category": "canvases",
    "description": "A canvas has been removed.",
    "fields": []
  },
  "CanvasNameChanged": {
    "category": "canvases",
    "description": "The name of a canvas has changed.",
    "fields": []
  },
  "CurrentSceneCollectionChanging": {
    "category": "config",
    "description": "The current scene collection has begun changing.",
    "fields": []
  },
  "CurrentSceneCollectionChanged": {
    "category": "config",
    "description": "The current scene collection has changed.",
    "fields": []
  },
  "SceneCollectionListChanged": {
    "category": "config",
    "description": "The scene collection list has changed.",
    "fields": []
  },
  "CurrentProfileChanging": {
    "category": "config",
    "description": "The current profile has begun changing.",
    "fields": []
  },
  "CurrentProfileChanged": {
    "category": "config",
    "description": "The current profile has changed.",
    "fields": []
  },
  "ProfileListChanged": {
    "category": "config",
    "description": "The profile list has changed.",
    "fields": []
  },
  "SourceFilterListReindexed": {
    "category": "filters",
    "description": "A source's filter list has been reindexed.",
    "fields": []
  },
  "SourceFilterCreated": {
    "category": "filters",
    "description": "A filter has been added to a source.",
    "fields": []
  },
  "SourceFilterRemoved": {
    "category": "filters",
    "description": "A filter has been removed from a source.",
    "fields": []
  },
  "SourceFilterNameChanged": {
    "category": "filters",
    "description": "The name of a source filter has changed.",
    "fields": []
  },
  "SourceFilterSettingsChanged": {
    "category": "filters",
    "description": "An source filter's settings have changed (been updated).",
    "fields": []
  },
  "SourceFilterEnableStateChanged": {
    "category": "filters",
    "description": "A source filter's enable state has changed.",
    "fields": []
  },
  "ExitStarted": {
    "category": "general",
    "description": "OBS has begun the shutdown process.",
    "fields": []
  },
  "InputCreated": {
    "category": "inputs",
    "description": "An input has been created.",
    "fields": []
  },
  "InputRemoved": {
    "category": "inputs",
    "description": "An input has been removed.",
    "fields": []
  },
  "InputNameChanged": {
    "category": "inputs",
    "description": "The name of an input has changed.",
    "fields": []
  },
  "InputSettingsChanged": {
    "category": "inputs",
    "description": "An input's settings have changed (been updated).",
    "fields": []
  },
  "InputActiveStateChanged": {
    "category": "inputs",
    "description": "An input's active state has changed.",
    "fields": []
  },
  "InputShowStateChanged": {
    "category": "inputs",
    "description": "An input's show state has changed.",
    "fields": []
  },
  "InputMuteStateChanged": {
    "category": "inputs",
    "description": "An input's mute state has changed.",
    "fields": []
  },
  "InputVolumeChanged": {
    "category": "inputs",
    "description": "An input's volume level has changed.",
    "fields": []
  },
  "InputAudioBalanceChanged": {
    "category": "inputs",
    "description": "The audio balance value of an input has changed.",
    "fields": []
  },
  "InputAudioSyncOffsetChanged": {
    "category": "inputs",
    "description": "The sync offset of an input has changed.",
    "fields": []
  },
  "InputAudioTracksChanged": {
    "category": "inputs",
    "description": "The audio tracks of an input have changed.",
    "fields": []
  },
  "InputAudioMonitorTypeChanged": {
    "category": "inputs",
    "description": "The monitor type of an input has changed.",
    "fields": []
  },
  "InputVolumeMeters": {
    "category": "inputs",
    "description": "A high-volume event providing volume levels of all active inputs every 50 milliseconds.",
    "fields": []
  },
  "MediaInputPlaybackStarted": {
    "category": "media inputs",
    "description": "A media input has started playing.",
    "fields": []
  },
  "MediaInputPlaybackEnded": {
    "category": "media inputs",
    "description": "A media input has finished playing.",
    "fields": []
  },
  "MediaInputActionTriggered": {
    "category": "media inputs",
    "description": "An action has been performed on an input.",
    "fields": []
  },
  "StreamStateChanged": {
    "category": "outputs",
    "description": "The state of the stream output has changed.",
    "fields": []
  },
  "RecordStateChanged": {
    "category": "outputs",
    "description": "The state of the record output has changed.",
    "fields": []
  },
  "RecordFileChanged": {
    "category": "outputs",
    "description": "The record output has started writing to a new file. For example, when a file split happens.",
    "fields": []
  },
  "ReplayBufferStateChanged": {
    "category": "outputs",
    "description": "The state of the replay buffer output has changed.",
    "fields": []
  },
  "VirtualcamStateChanged": {
    "category": "outputs",
    "description": "The state of the virtualcam output has changed.",
    "fields": []
  },
  "ReplayBufferSaved": {
    "category": "outputs",
    "description": "The replay buffer has been saved.",
    "fields": []
  },
  "SceneItemCreated": {
    "category": "scene items",
    "description": "A scene item has been created.",
    "fields": []
  },
  "SceneItemRemoved": {
    "category": "scene items",
    "description": "A scene item has been removed.",
    "fields": []
  },
  "SceneItemListReindexed": {
    "category": "scene items",
    "description": "A scene's item list has been reindexed.",
    "fields": []
  },
  "SceneItemEnableStateChanged": {
    "category": "scene items",
    "description": "A scene item's enable state has changed.",
    "fields": []
  },
  "SceneItemLockStateChanged": {
    "category": "scene items",
    "description": "A scene item's lock state has changed.",
    "fields": []
  },
  "SceneItemSelected": {
    "category": "scene items",
    "description": "A scene item has been selected in the Ui.",
    "fields": []
  },
  "SceneItemTransformChanged": {
    "category": "scene items",
    "description": "The transform/crop of a scene item has changed.",
    "fields": []
  },
  "SceneCreated": {
    "category": "scenes",
    "description": "A new scene has been created.",
    "fields": []
  },
  "SceneRemoved": {
    "category": "scenes",
    "description": "A scene has been removed.",
    "fields": []
  },
  "SceneNameChanged": {
    "category": "scenes",
    "description": "The name of a scene has changed.",
    "fields": []
  },
  "CurrentProgramSceneChanged": {
    "category": "scenes",
    "description": "The current program scene has changed.",
    "fields": []
  },
  "CurrentPreviewSceneChanged": {
    "category": "scenes",
    "description": "The current preview scene has changed.",
    "fields": []
  },
  "SceneListChanged": {
    "category": "scenes",
    "description": "The list of scenes has changed.",
    "fields": []
  },
  "CurrentSceneTransitionChanged": {
    "category": "transitions",
    "description": "The current scene transition has changed.",
    "fields": []
  },
  "CurrentSceneTransitionDurationChanged": {
    "category": "transitions",
    "description": "The current scene transition duration has changed.",
    "fields": []
  },
  "SceneTransitionStarted": {
    "category": "transitions",
    "description": "A scene transition has started.",
    "fields": []
  },
  "SceneTransitionEnded": {
    "category": "transitions",
    "description": "A scene transition has completed fully.",
    "fields": []
  },
  "SceneTransitionVideoEnded": {
    "category": "transitions",
    "description": "A scene transition's video has completed fully.",
    "fields": []
  },
  "StudioModeStateChanged": {
    "category": "ui",
    "description": "Studio mode has been enabled or disabled.",
    "fields": []
  },
  "ScreenshotSaved": {
    "category": "ui",
    "description": "A screenshot has been saved.",
    "fields": []
  },
  "VendorEvent": {
    "category": "general",
    "description": "An event has been emitted from a vendor.",
    "fields": []
  },
  "CustomEvent": {
    "category": "general",
    "description": "Custom event emitted by `BroadcastCustomEvent`.",
    "fields": []
  }
};

/* Request type names grouped by category. */
export const REQUEST_CATEGORIES = {
  "canvases": [
    "GetCanvasList"
  ],
  "config": [
    "CreateProfile",
    "CreateSceneCollection",
    "GetPersistentData",
    "GetProfileList",
    "GetProfileParameter",
    "GetRecordDirectory",
    "GetSceneCollectionList",
    "GetStreamServiceSettings",
    "GetVideoSettings",
    "RemoveProfile",
    "SetCurrentProfile",
    "SetCurrentSceneCollection",
    "SetPersistentData",
    "SetProfileParameter",
    "SetRecordDirectory",
    "SetStreamServiceSettings",
    "SetVideoSettings"
  ],
  "filters": [
    "CreateSourceFilter",
    "GetSourceFilter",
    "GetSourceFilterDefaultSettings",
    "GetSourceFilterKindList",
    "GetSourceFilterList",
    "RemoveSourceFilter",
    "SetSourceFilterEnabled",
    "SetSourceFilterIndex",
    "SetSourceFilterName",
    "SetSourceFilterSettings"
  ],
  "general": [
    "BroadcastCustomEvent",
    "CallVendorRequest",
    "GetHotkeyList",
    "GetStats",
    "GetVersion",
    "Sleep",
    "TriggerHotkeyByKeySequence",
    "TriggerHotkeyByName"
  ],
  "inputs": [
    "CreateInput",
    "GetInputAudioBalance",
    "GetInputAudioMonitorType",
    "GetInputAudioSyncOffset",
    "GetInputAudioTracks",
    "GetInputDefaultSettings",
    "GetInputDeinterlaceFieldOrder",
    "GetInputDeinterlaceMode",
    "GetInputKindList",
    "GetInputList",
    "GetInputMute",
    "GetInputPropertiesListPropertyItems",
    "GetInputSettings",
    "GetInputVolume",
    "GetSpecialInputs",
    "PressInputPropertiesButton",
    "RemoveInput",
    "SetInputAudioBalance",
    "SetInputAudioMonitorType",
    "SetInputAudioSyncOffset",
    "SetInputAudioTracks",
    "SetInputDeinterlaceFieldOrder",
    "SetInputDeinterlaceMode",
    "SetInputMute",
    "SetInputName",
    "SetInputSettings",
    "SetInputVolume",
    "ToggleInputMute"
  ],
  "media inputs": [
    "GetMediaInputStatus",
    "OffsetMediaInputCursor",
    "SetMediaInputCursor",
    "TriggerMediaInputAction"
  ],
  "outputs": [
    "GetLastReplayBufferReplay",
    "GetOutputList",
    "GetOutputSettings",
    "GetOutputStatus",
    "GetReplayBufferStatus",
    "GetVirtualCamStatus",
    "SaveReplayBuffer",
    "SetOutputSettings",
    "StartOutput",
    "StartReplayBuffer",
    "StartVirtualCam",
    "StopOutput",
    "StopReplayBuffer",
    "StopVirtualCam",
    "ToggleOutput",
    "ToggleReplayBuffer",
    "ToggleVirtualCam"
  ],
  "record": [
    "CreateRecordChapter",
    "GetRecordStatus",
    "PauseRecord",
    "ResumeRecord",
    "SplitRecordFile",
    "StartRecord",
    "StopRecord",
    "ToggleRecord",
    "ToggleRecordPause"
  ],
  "scene items": [
    "CreateSceneItem",
    "DuplicateSceneItem",
    "GetGroupSceneItemList",
    "GetSceneItemBlendMode",
    "GetSceneItemEnabled",
    "GetSceneItemId",
    "GetSceneItemIndex",
    "GetSceneItemList",
    "GetSceneItemLocked",
    "GetSceneItemSource",
    "GetSceneItemTransform",
    "RemoveSceneItem",
    "SetSceneItemBlendMode",
    "SetSceneItemEnabled",
    "SetSceneItemIndex",
    "SetSceneItemLocked",
    "SetSceneItemTransform"
  ],
  "scenes": [
    "CreateScene",
    "GetCurrentPreviewScene",
    "GetCurrentProgramScene",
    "GetGroupList",
    "GetSceneList",
    "GetSceneSceneTransitionOverride",
    "RemoveScene",
    "SetCurrentPreviewScene",
    "SetCurrentProgramScene",
    "SetSceneName",
    "SetSceneSceneTransitionOverride"
  ],
  "sources": [
    "GetSourceActive",
    "GetSourceScreenshot",
    "SaveSourceScreenshot"
  ],
  "stream": [
    "GetStreamStatus",
    "SendStreamCaption",
    "StartStream",
    "StopStream",
    "ToggleStream"
  ],
  "transitions": [
    "GetCurrentSceneTransition",
    "GetCurrentSceneTransitionCursor",
    "GetSceneTransitionList",
    "GetTransitionKindList",
    "SetCurrentSceneTransition",
    "SetCurrentSceneTransitionDuration",
    "SetCurrentSceneTransitionSettings",
    "SetTBarPosition",
    "TriggerStudioModeTransition"
  ],
  "ui": [
    "GetMonitorList",
    "GetStudioModeEnabled",
    "OpenInputFiltersDialog",
    "OpenInputInteractDialog",
    "OpenInputPropertiesDialog",
    "OpenSourceProjector",
    "OpenVideoMixProjector",
    "SetStudioModeEnabled"
  ]
};

/* Event type names grouped by category. */
export const EVENT_CATEGORIES = {
  "canvases": [
    "CanvasCreated",
    "CanvasNameChanged",
    "CanvasRemoved"
  ],
  "config": [
    "CurrentProfileChanged",
    "CurrentProfileChanging",
    "CurrentSceneCollectionChanged",
    "CurrentSceneCollectionChanging",
    "ProfileListChanged",
    "SceneCollectionListChanged"
  ],
  "filters": [
    "SourceFilterCreated",
    "SourceFilterEnableStateChanged",
    "SourceFilterListReindexed",
    "SourceFilterNameChanged",
    "SourceFilterRemoved",
    "SourceFilterSettingsChanged"
  ],
  "general": [
    "CustomEvent",
    "ExitStarted",
    "VendorEvent"
  ],
  "inputs": [
    "InputActiveStateChanged",
    "InputAudioBalanceChanged",
    "InputAudioMonitorTypeChanged",
    "InputAudioSyncOffsetChanged",
    "InputAudioTracksChanged",
    "InputCreated",
    "InputMuteStateChanged",
    "InputNameChanged",
    "InputRemoved",
    "InputSettingsChanged",
    "InputShowStateChanged",
    "InputVolumeChanged",
    "InputVolumeMeters"
  ],
  "media inputs": [
    "MediaInputActionTriggered",
    "MediaInputPlaybackEnded",
    "MediaInputPlaybackStarted"
  ],
  "outputs": [
    "RecordFileChanged",
    "RecordStateChanged",
    "ReplayBufferSaved",
    "ReplayBufferStateChanged",
    "StreamStateChanged",
    "VirtualcamStateChanged"
  ],
  "scene items": [
    "SceneItemCreated",
    "SceneItemEnableStateChanged",
    "SceneItemListReindexed",
    "SceneItemLockStateChanged",
    "SceneItemRemoved",
    "SceneItemSelected",
    "SceneItemTransformChanged"
  ],
  "scenes": [
    "CurrentPreviewSceneChanged",
    "CurrentProgramSceneChanged",
    "SceneCreated",
    "SceneListChanged",
    "SceneNameChanged",
    "SceneRemoved"
  ],
  "transitions": [
    "CurrentSceneTransitionChanged",
    "CurrentSceneTransitionDurationChanged",
    "SceneTransitionEnded",
    "SceneTransitionStarted",
    "SceneTransitionVideoEnded"
  ],
  "ui": [
    "ScreenshotSaved",
    "StudioModeStateChanged"
  ]
};

/** List of every request type in the protocol. */
export const REQUEST_TYPES = Object.freeze(Object.keys(REQUESTS));

/** List of every event type in the protocol. */
export const EVENT_TYPES = Object.freeze(Object.keys(EVENTS));