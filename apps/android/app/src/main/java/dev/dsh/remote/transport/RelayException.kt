package dev.dsh.remote.transport

/**
 * Единая ошибка транспорта: вид (для UI и решений «повторять ли»), HTTP-статус,
 * `error.code` релея и `Retry-After`.
 *
 * §5 контракта: набор кодов открытый, незнакомый код клиент трактует как `internal`
 * (`Kind.Server`/`Kind.Protocol`), `4xx` (кроме `429`) не повторяются.
 */
class RelayException(
    val kind: Kind,
    message: String,
    val httpStatus: Int? = null,
    val errorCode: String? = null,
    val retryAfterSeconds: Long? = null,
    cause: Throwable? = null,
) : Exception(message, cause) {

    enum class Kind {
        Unauthorized,
        Forbidden,
        NotFound,
        Conflict,
        Expired,
        PayloadTooLarge,
        UnsupportedVersion,
        BadRequest,
        RateLimited,
        Server,
        Network,
        Protocol,
    }

    /** Повторять можно только `5xx`, `429` и сетевые ошибки (§4). */
    val retryable: Boolean
        get() = when (kind) {
            Kind.Server, Kind.Network, Kind.RateLimited -> true
            else -> false
        }

    override fun toString(): String = "RelayException(kind=$kind, http=$httpStatus, code=$errorCode): $message"
}
