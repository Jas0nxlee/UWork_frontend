#include <node_api.h>
#include <unistd.h>
#include <fcntl.h>
#include <climits>
#include <cmath>
#include <new>

extern "C" int32_t uwork_verify_peer(int32_t fd);

namespace {
struct Verification {
  napi_async_work work = nullptr;
  napi_deferred deferred = nullptr;
  int fd = -1;
  bool authorized = false;
};

void CloseDescriptor(Verification* verification) {
  if (verification->fd >= 0) {
    close(verification->fd);
    verification->fd = -1;
  }
}

void Execute(napi_env, void* data) {
  auto* verification = static_cast<Verification*>(data);
  verification->authorized = uwork_verify_peer(verification->fd) == 1;
  CloseDescriptor(verification);
}

void Complete(napi_env env, napi_status status, void* data) {
  auto* verification = static_cast<Verification*>(data);
  CloseDescriptor(verification);
  napi_value result;
  if (napi_get_boolean(env, status == napi_ok && verification->authorized, &result) == napi_ok) {
    napi_resolve_deferred(env, verification->deferred, result);
  }
  napi_delete_async_work(env, verification->work);
  delete verification;
}

napi_value VerifyPeer(napi_env env, napi_callback_info callback) {
  napi_deferred deferred;
  napi_value promise;
  if (napi_create_promise(env, &deferred, &promise) != napi_ok) return nullptr;
  auto refuse = [&]() {
    napi_value result;
    if (napi_get_boolean(env, false, &result) == napi_ok) napi_resolve_deferred(env, deferred, result);
    return promise;
  };
  size_t argc = 1;
  napi_value arguments[1];
  double descriptor;
  if (napi_get_cb_info(env, callback, &argc, arguments, nullptr, nullptr) != napi_ok || argc != 1 ||
      napi_get_value_double(env, arguments[0], &descriptor) != napi_ok || !std::isfinite(descriptor) ||
      descriptor < 0 || descriptor > INT_MAX || std::floor(descriptor) != descriptor) return refuse();

  // 必须在返回 JS 前 dup；socket 关闭后的 fd 复用不能把验证对象换成另一个连接。
  const int owned_fd = fcntl(static_cast<int>(descriptor), F_DUPFD_CLOEXEC, 0);
  if (owned_fd < 0) return refuse();
  auto* verification = new (std::nothrow) Verification();
  if (!verification) {
    close(owned_fd);
    return refuse();
  }
  verification->fd = owned_fd;
  verification->deferred = deferred;
  napi_value name;
  if (napi_create_string_utf8(env, "UWorkPeerAuthorization", NAPI_AUTO_LENGTH, &name) != napi_ok ||
      napi_create_async_work(env, nullptr, name, Execute, Complete, verification, &verification->work) != napi_ok ||
      napi_queue_async_work(env, verification->work) != napi_ok) {
    CloseDescriptor(verification);
    if (verification->work) napi_delete_async_work(env, verification->work);
    delete verification;
    return refuse();
  }
  return promise;
}

napi_value Init(napi_env env, napi_value exports) {
  napi_value function;
  if (napi_create_function(env, "verifyPeer", NAPI_AUTO_LENGTH, VerifyPeer, nullptr, &function) != napi_ok ||
      napi_set_named_property(env, exports, "verifyPeer", function) != napi_ok) return nullptr;
  return exports;
}
}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
