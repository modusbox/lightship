<a name="lightship"></a>
# Lightship 🚢

Forked from /gajus/lightship  to add more detailed info on the `/health` endpoint. For setup on a k8s cluster see [https://github.com/modusbox/lightship#lightship-]

## Using it

The `/health` info returns `application/json` with a detail of the server status.
The library provides a basic response with a json object which includes:

- log: an Array of LogEntries. This are created by calling `lightsail.startStep(message)`. If the same message is logged ( usually when there's a retry ), the library logs the timestamp of the last message and the message count
- state: one of the State constants
- statusCode: the status code that is also returned as the HTTP status code

If you want to include extra info, on the `detail` property, you need to register a callback  as in:

```js
lightship.healthInfoProvider( async () => { return {what: 'ever'};});
```

An example response:

```json
{
  "detail": {
    "what": "ever"
  },
  "log": {
    "log": [
      {
        "count": 1,
        "lastTimestamp": "2021-01-27T21:24:09.614Z",
        "message": "ZPL startup: BEGIN"
      },
      {
        "count": 1,
        "lastTimestamp": "2021-01-27T21:24:10.971Z",
        "message": "ZPL startup took 3806 ms"
      }
    ]
  },
  "state": "SERVER_IS_READY",
  "statusCode": 200
}
```


```bash
curl -i  http://localhost:9084/live
```

returns

```
HTTP/1.1 200 OK
X-Powered-By: Express
Content-Type: text/html; charset=utf-8
Content-Length: 27
ETag: W/"1b-8L3P/D0/E9g5e45JCynGSp+VR+Q"
Date: Wed, 27 Jan 2021 21:26:26 GMT
Connection: keep-alive

SERVER_IS_NOT_SHUTTING_DOWN
```

```bash
curl -i  http://localhost:9084/ready
```

returns

```
HTTP/1.1 200 OK
X-Powered-By: Express
Content-Type: text/html; charset=utf-8
Content-Length: 15
ETag: W/"f-4LrF2MQgHclg2zEmsL0O1FaMnZs"
Date: Wed, 27 Jan 2021 21:27:41 GMT
Connection: keep-alive

SERVER_IS_READY
```


